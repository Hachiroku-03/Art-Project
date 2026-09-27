import json
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from db import get_db

router = APIRouter()

VALID_KINDS = {"text", "image", "voice"}


# ---------------------------------------------------------------------------
# Connection registry. One user may hold many sockets (tabs/devices).
# A lock guards add/remove so concurrent connects can't corrupt the sets;
# broadcasts snapshot the set first so a disconnect mid-iteration is safe.
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self._conns: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user: str, ws: WebSocket):
        async with self._lock:
            self._conns.setdefault(user, set()).add(ws)

    async def disconnect(self, user: str, ws: WebSocket):
        async with self._lock:
            s = self._conns.get(user)
            if s:
                s.discard(ws)
                if not s:
                    self._conns.pop(user, None)

    async def send_to_users(self, users, data: str, exclude: WebSocket | None = None) -> set[str]:
        delivered: set[str] = set()

        for u in set(users):
            ok = False

            for ws in list(self._conns.get(u, ())):
                if ws is exclude:
                    continue

                try:
                    await ws.send_text(data)
                    ok = True
                except Exception:
                    try:
                        await self.disconnect(u, ws)
                    except Exception:
                        pass

            if ok:
                delivered.add(u)

        return delivered


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _pair_key(a: str, b: str) -> str:
    return "|".join(sorted([a.strip().lower(), b.strip().lower()]))


def _canonical_username(cursor, name: str):
    """
    Resolve a username exactly first, then case-insensitively.
    Returns the real username stored in users.username, or None.
    """
    name = (name or "").strip()
    if not name:
        return None

    cursor.execute("SELECT username FROM users WHERE username = %s", (name,))
    row = cursor.fetchone()
    if row:
        return row["username"]

    cursor.execute("SELECT username FROM users WHERE lower(username) = lower(%s)", (name,))
    row = cursor.fetchone()
    return row["username"] if row else None


def _is_member(cursor, conv_id: int, user: str) -> bool:
    cursor.execute(
        "SELECT 1 FROM chat_members WHERE conversation_id=%s AND user_name=%s",
        (conv_id, user),
    )
    return cursor.fetchone() is not None


def _member_names(cursor, conv_id: int) -> list[str]:
    cursor.execute("SELECT user_name FROM chat_members WHERE conversation_id=%s", (conv_id,))
    return [r["user_name"] for r in cursor.fetchall()]


def _member_names_from_id(conv_id: int) -> list[str]:
    conn = get_db()
    cursor = conn.cursor()
    names = _member_names(cursor, conv_id)
    conn.close()
    return names


def _message_row(cursor, msg_id: int) -> dict | None:
    """Re-select a message joined with profile so the bubble has display+avatar."""
    cursor.execute(
        '''
        SELECT m.id, m.conversation_id, m.sender, m.kind, m.body,
               m.created_at::text AS created_at,
               p.display_name AS sender_display,
               p.avatar_url   AS sender_avatar,
               u.tier         AS sender_tier
        FROM chat_messages m
        JOIN users u ON u.username = m.sender
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE m.id = %s
        ''',
        (msg_id,),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def _record_delivery(cursor, conv_id: int, user_name: str, msg_id: int):
    """
    Mark that a message was delivered to a user's live socket.
    Delivery is separate from read. Read implies delivered.
    """
    cursor.execute(
        '''
        INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
        VALUES (%s, %s, 0, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (conversation_id, user_name)
        DO UPDATE SET
            last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_delivered_id),
            updated_at = CURRENT_TIMESTAMP
        ''',
        (conv_id, user_name, msg_id),
    )


def _cursors_for_conv(cursor, conv_id: int):
    cursor.execute(
        '''
        SELECT user_name, last_read_id, last_delivered_id
        FROM chat_reads
        WHERE conversation_id = %s
        ''',
        (conv_id,),
    )

    read_cursors: dict[str, int] = {}
    delivered_cursors: dict[str, int] = {}

    for row in cursor.fetchall():
        read_cursors[row["user_name"]] = int(row["last_read_id"] or 0)
        delivered_cursors[row["user_name"]] = int(row["last_delivered_id"] or 0)

    return read_cursors, delivered_cursors


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@router.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    raw_viewer = websocket.query_params.get("viewer", "").strip()
    if not raw_viewer:
        await websocket.close(code=4401)
        return

    conn = get_db()
    cursor = conn.cursor()
    viewer = _canonical_username(cursor, raw_viewer)
    conn.close()

    if not viewer:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    await manager.connect(viewer, websocket)

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "error": "bad json"}))
                continue

            ctype = data.get("type")

            # ---- send a message ----
            if ctype == "message":
                conv_id = data.get("conversation_id")
                kind = data.get("kind", "text")
                body = (data.get("body") or "").strip()
                temp_id = data.get("temp_id")

                if conv_id is None or kind not in VALID_KINDS or not body:
                    await websocket.send_text(
                        json.dumps({"type": "error", "temp_id": temp_id, "error": "invalid message"})
                    )
                    continue

                conn = get_db()
                cursor = conn.cursor()

                try:
                    if not _is_member(cursor, conv_id, viewer):
                        await websocket.send_text(
                            json.dumps({"type": "error", "temp_id": temp_id, "error": "not a member"})
                        )
                        continue

                    cursor.execute(
                        "INSERT INTO chat_messages (conversation_id, sender, kind, body) VALUES (%s,%s,%s,%s) RETURNING id",
                        (conv_id, viewer, kind, body),
                    )
                    msg_id = cursor.fetchone()["id"]
                    row = _message_row(cursor, msg_id)
                    members = _member_names(cursor, conv_id)
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    await websocket.send_text(
                        json.dumps({"type": "error", "temp_id": temp_id, "error": str(e)})
                    )
                    continue
                finally:
                    conn.close()

                if row is None:
                    await websocket.send_text(
                        json.dumps({"type": "error", "temp_id": temp_id, "error": "message not found after insert"})
                    )
                    continue

                # Ack the sending tab so it can replace its optimistic bubble.
                await websocket.send_text(json.dumps({"type": "ack", "temp_id": temp_id, "message": row}))

                # Broadcast the real message to all members except this exact sending socket.
                payload = json.dumps({"type": "message", "message": row})
                delivered = await manager.send_to_users(members, payload, exclude=websocket)

                # Remove sender from delivery recipients.
                recipient_deliveries = delivered - {viewer}

                if recipient_deliveries:
                    conn2 = get_db()
                    cursor2 = conn2.cursor()

                    try:
                        for u in recipient_deliveries:
                            _record_delivery(cursor2, conv_id, u, msg_id)
                        conn2.commit()
                    except Exception:
                        conn2.rollback()
                    finally:
                        conn2.close()

                    # Tell the sender's sockets which recipients received it.
                    for u in recipient_deliveries:
                        frame = json.dumps({
                            "type": "delivery",
                            "conversation_id": conv_id,
                            "user_name": u,
                            "last_delivered_id": msg_id,
                        })

                        # Current sender tab.
                        try:
                            await websocket.send_text(frame)
                        except Exception:
                            pass

                        # Other sender tabs.
                        await manager.send_to_users([viewer], frame, exclude=websocket)

            # ---- mark read ----
            elif ctype == "read":
                conv_id = data.get("conversation_id")

                try:
                    last_id = int(data.get("last_read_id") or 0)
                except Exception:
                    continue

                if conv_id is None:
                    continue

                conn = get_db()
                cursor = conn.cursor()

                try:
                    if not _is_member(cursor, conv_id, viewer):
                        continue

                    # Reading implies delivered.
                    cursor.execute(
                        '''
                        INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
                        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT (conversation_id, user_name)
                        DO UPDATE SET
                            last_read_id = EXCLUDED.last_read_id,
                            last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_read_id),
                            updated_at = CURRENT_TIMESTAMP
                        ''',
                        (conv_id, viewer, last_id, last_id),
                    )
                    conn.commit()
                except Exception:
                    conn.rollback()
                    continue
                finally:
                    conn.close()

                members = _member_names_from_id(conv_id)
                await manager.send_to_users(
                    members,
                    json.dumps({
                        "type": "read",
                        "conversation_id": conv_id,
                        "user_name": viewer,
                        "last_read_id": last_id,
                    }),
                    exclude=websocket,
                )

            # ---- typing ----
            elif ctype == "typing":
                conv_id = data.get("conversation_id")

                if conv_id is None:
                    continue

                members = _member_names_from_id(conv_id)
                await manager.send_to_users(
                    members,
                    json.dumps({
                        "type": "typing",
                        "conversation_id": conv_id,
                        "user_name": viewer,
                    }),
                    exclude=websocket,
                )

            else:
                await websocket.send_text(json.dumps({"type": "error", "error": f"unknown type {ctype}"}))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.disconnect(viewer, websocket)


# ---------------------------------------------------------------------------
# REST: conversation list
# ---------------------------------------------------------------------------
@router.get("/chat/conversations")
def list_conversations(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        '''
        SELECT c.id, c.kind, c.name, c.image_url,
               (SELECT m.body   FROM chat_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
               (SELECT m.kind   FROM chat_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
               (SELECT m.sender FROM chat_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
               (SELECT m.created_at::text FROM chat_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
               (SELECT COUNT(*) FROM chat_messages m
                 WHERE m.conversation_id=c.id AND m.sender <> %s
                   AND m.id > COALESCE((SELECT r.last_read_id FROM chat_reads r
                                        WHERE r.conversation_id=c.id AND r.user_name=%s),0)) AS unread,

               (SELECT COALESCE(p.display_name, u.username)
                  FROM chat_members cm JOIN users u ON u.username=cm.user_name
                  LEFT JOIN profiles p ON p.user_id=u.id
                 WHERE cm.conversation_id=c.id AND cm.user_name <> %s LIMIT 1) AS counterpart,

               (SELECT p2.avatar_url
                  FROM chat_members cm2 JOIN users u2 ON u2.username=cm2.user_name
                  LEFT JOIN profiles p2 ON p2.user_id=u2.id
                 WHERE cm2.conversation_id=c.id AND cm2.user_name <> %s LIMIT 1) AS counterpart_avatar

        FROM chat_conversations c
        WHERE c.id IN (SELECT conversation_id FROM chat_members WHERE user_name = %s)
        ORDER BY last_at DESC NULLS LAST, c.id DESC
        ''',
        (viewer, viewer, viewer, viewer, viewer),
    )

    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return {"conversations": rows}


# ---------------------------------------------------------------------------
# REST: create a conversation (direct or group)
# ---------------------------------------------------------------------------
@router.post("/chat/conversations")
def create_conversation(data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    kind = data.get("kind", "direct")

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if kind == "direct":
            target = _canonical_username(cursor, data.get("target") or "")

            if not target:
                conn.rollback()
                return {"error": "target user does not exist"}

            if target == viewer:
                conn.rollback()
                return {"error": "you cannot message yourself"}

            pk = _pair_key(viewer, target)

            cursor.execute("SELECT id FROM chat_conversations WHERE pair_key = %s", (pk,))
            row = cursor.fetchone()

            if row:
                conv_id = row["id"]
            else:
                cursor.execute(
                    """
                    INSERT INTO chat_conversations (kind, pair_key, created_by)
                    VALUES ('direct', %s, %s)
                    RETURNING id
                    """,
                    (pk, viewer),
                )
                conv_id = cursor.fetchone()["id"]

            for member in {viewer, target}:
                cursor.execute(
                    """
                    INSERT INTO chat_members (conversation_id, user_name, role)
                    VALUES (%s, %s, 'member')
                    ON CONFLICT DO NOTHING
                    """,
                    (conv_id, member),
                )

            conn.commit()
            return {
                "conversation_id": conv_id,
                "kind": "direct",
                "participants": [viewer, target],
            }

        if kind == "group":
            name = (data.get("name") or "").strip()
            if not name:
                conn.rollback()
                return {"error": "group needs a name"}

            raw_members = data.get("members") or []
            resolved = []
            unknown = []

            for raw in raw_members:
                member = _canonical_username(cursor, raw)
                if not member:
                    unknown.append(raw)
                elif member != viewer:
                    resolved.append(member)

            if unknown:
                conn.rollback()
                return {"error": f"unknown members: {', '.join(unknown)}"}

            cursor.execute(
                """
                INSERT INTO chat_conversations (kind, name, image_url, created_by)
                VALUES ('group', %s, %s, %s)
                RETURNING id
                """,
                (name, (data.get("image_url") or "").strip() or None, viewer),
            )
            conv_id = cursor.fetchone()["id"]

            cursor.execute(
                """
                INSERT INTO chat_members (conversation_id, user_name, role)
                VALUES (%s, %s, 'owner')
                """,
                (conv_id, viewer),
            )

            for member in sorted(set(resolved)):
                cursor.execute(
                    """
                    INSERT INTO chat_members (conversation_id, user_name, role)
                    VALUES (%s, %s, 'member')
                    ON CONFLICT DO NOTHING
                    """,
                    (conv_id, member),
                )

            conn.commit()
            return {
                "conversation_id": conv_id,
                "kind": "group",
                "participants": [viewer, *sorted(set(resolved))],
            }

        conn.rollback()
        return {"error": "kind must be direct or group"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: add a member to a group
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/members")
def add_member(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    target_raw = (data.get("user_name") or "").strip()

    if not viewer_raw or not target_raw:
        return {"error": "viewer and user_name required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        target = _canonical_username(cursor, target_raw)

        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not target:
            conn.rollback()
            return {"error": "unknown user"}

        if not _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not a member"}

        cursor.execute(
            """
            INSERT INTO chat_members (conversation_id, user_name, role)
            VALUES (%s, %s, 'member')
            ON CONFLICT DO NOTHING
            """,
            (conv_id, target),
        )
        conn.commit()
        return {"message": "member added"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: history (incremental with ?since=, latest page otherwise)
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/messages")
def history(conv_id: int, viewer: str = "", since: int = 0, limit: int = 50):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    if not _is_member(cursor, conv_id, viewer):
        conn.close()
        return {"error": "not a member"}

    if since > 0:
        cursor.execute(
            '''
            SELECT m.id, m.conversation_id, m.sender, m.kind, m.body, m.created_at::text AS created_at,
                   p.display_name AS sender_display, p.avatar_url AS sender_avatar, u.tier AS sender_tier
            FROM chat_messages m
            JOIN users u ON u.username = m.sender
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE m.conversation_id = %s AND m.id > %s
            ORDER BY m.id ASC
            ''',
            (conv_id, since),
        )
        rows = [dict(r) for r in cursor.fetchall()]
    else:
        cursor.execute(
            '''
            SELECT m.id, m.conversation_id, m.sender, m.kind, m.body, m.created_at::text AS created_at,
                   p.display_name AS sender_display, p.avatar_url AS sender_avatar, u.tier AS sender_tier
            FROM chat_messages m
            JOIN users u ON u.username = m.sender
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE m.conversation_id = %s
            ORDER BY m.id DESC LIMIT %s
            ''',
            (conv_id, max(1, min(limit, 200))),
        )
        rows = [dict(r) for r in cursor.fetchall()][::-1]

    read_cursors, delivered_cursors = _cursors_for_conv(cursor, conv_id)
    conn.close()

    return {
        "messages": rows,
        "read_cursors": read_cursors,
        "delivered_cursors": delivered_cursors,
    }


# ---------------------------------------------------------------------------
# REST: send fallback when websocket is not open
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/messages")
async def send_rest(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    kind = data.get("kind", "text")
    body = (data.get("body") or "").strip()

    if not viewer_raw or kind not in VALID_KINDS or not body:
        return {"error": "invalid message"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not a member"}

        cursor.execute(
            "INSERT INTO chat_messages (conversation_id, sender, kind, body) VALUES (%s,%s,%s,%s) RETURNING id",
            (conv_id, viewer, kind, body),
        )
        msg_id = cursor.fetchone()["id"]
        row = _message_row(cursor, msg_id)
        members = _member_names(cursor, conv_id)
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    if row is None:
        return {"error": "message not found after insert"}

    payload = json.dumps({"type": "message", "message": row})
    delivered = await manager.send_to_users(members, payload)

    recipient_deliveries = delivered - {viewer}

    if recipient_deliveries:
        conn2 = get_db()
        cursor2 = conn2.cursor()

        try:
            for u in recipient_deliveries:
                _record_delivery(cursor2, conv_id, u, msg_id)
            conn2.commit()
        except Exception:
            conn2.rollback()
        finally:
            conn2.close()

        for u in recipient_deliveries:
            frame = json.dumps({
                "type": "delivery",
                "conversation_id": conv_id,
                "user_name": u,
                "last_delivered_id": msg_id,
            })
            await manager.send_to_users([viewer], frame)

    return {"message": row}


# ---------------------------------------------------------------------------
# REST: mark read fallback
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/read")
async def mark_read(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    try:
        last_id = int(data.get("last_read_id") or 0)
    except Exception:
        return {"error": "invalid last_read_id"}

    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not a member"}

        cursor.execute(
            '''
            INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
            VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (conversation_id, user_name)
            DO UPDATE SET
                last_read_id = EXCLUDED.last_read_id,
                last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_read_id),
                updated_at = CURRENT_TIMESTAMP
            ''',
            (conv_id, viewer, last_id, last_id),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    members = _member_names_from_id(conv_id)
    await manager.send_to_users(
        members,
        json.dumps({
            "type": "read",
            "conversation_id": conv_id,
            "user_name": viewer,
            "last_read_id": last_id,
        }),
    )

    return {"message": "read"}