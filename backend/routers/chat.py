import json
import asyncio
import re
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from db import get_db
from notification_service import create_notification

import datetime as _dt
from zoneinfo import ZoneInfo

_TZ_CACHE = None


def _db_tz():
    global _TZ_CACHE
    if _TZ_CACHE is None:
        try:
            c = get_db()
            cur = c.cursor()
            cur.execute("SHOW TIME ZONE")
            row = cur.fetchone()
            c.close()
            name = (row or {}).get("TimeZone") or (row or {}).get("timezone")
            _TZ_CACHE = ZoneInfo(name) if name else ZoneInfo("UTC")
        except Exception:
            _TZ_CACHE = ZoneInfo("UTC")
    return _TZ_CACHE


def _iso(v):
    if isinstance(v, _dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=_db_tz())
        return v.isoformat()
    return v


def _localize(row, *keys):
    if not row:
        return row
    for k in keys:
        if k in row:
            row[k] = _iso(row[k])
    return row


router = APIRouter()

MESSAGE_KINDS = {
    "text",
    "image",
    "voice",
    "file",
    "video",
    "location",
    "contact",
    "system",
}

# Users may not forge system messages through normal send endpoints.
USER_KINDS = MESSAGE_KINDS - {"system"}


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

        async def send_one(user: str, ws: WebSocket) -> tuple[str, bool]:
            try:
                await ws.send_text(data)
                return user, True
            except Exception:
                try:
                    await self.disconnect(user, ws)
                except Exception:
                    pass
                return user, False

        tasks = []

        for u in set(users):
            for ws in list(self._conns.get(u, ())):
                if ws is exclude:
                    continue
                tasks.append(send_one(u, ws))

        if not tasks:
            return delivered

        results = await asyncio.gather(*tasks, return_exceptions=True)

        for res in results:
            if isinstance(res, tuple) and res[1]:
                delivered.add(res[0])

        return delivered


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _pair_key(a: str, b: str) -> str:
    return "|".join(sorted([a.strip().lower(), b.strip().lower()]))


def _optional_int(value) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except Exception:
        raise ValueError("invalid integer")


def _extract_links(body: str):
    if not body:
        return []

    raw_urls = re.findall(r'''https?://[^\s<>"']+''', body)

    out = []
    seen = set()

    for raw in raw_urls:
        url = raw.rstrip(".,;:!?)]}\"'")

        if not url or url in seen:
            continue

        seen.add(url)

        try:
            domain = urlparse(url).netloc or url
        except Exception:
            domain = url

        out.append(
            {
                "url": url,
                "domain": domain,
            }
        )

        if len(out) >= 5:
            break

    return out


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


def _resolve_viewer(viewer_raw: str):
    if not viewer_raw:
        return None
    conn = get_db()
    cursor = conn.cursor()
    viewer = _canonical_username(cursor, viewer_raw)
    conn.close()
    return viewer


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


def _is_blocked_direct(cursor, conv_id: int, viewer: str) -> bool:
    """
    For direct conversations, block both directions if either user blocked the other.
    Group blocking policy is deferred.
    """
    cursor.execute(
        """
        SELECT 1
        FROM chat_conversations c
        JOIN chat_members other_m
          ON other_m.conversation_id = c.id
         AND other_m.user_name <> %s
        WHERE c.id = %s
          AND c.kind = 'direct'
          AND EXISTS (
              SELECT 1
              FROM chat_blocks b
              WHERE (b.blocker = %s AND b.blocked = other_m.user_name)
                 OR (b.blocker = other_m.user_name AND b.blocked = %s)
          )
        LIMIT 1
        """,
        (viewer, conv_id, viewer, viewer),
    )
    return cursor.fetchone() is not None


def _set_presence(cursor, user: str, online: bool):
    if online:
        cursor.execute(
            """
            INSERT INTO chat_presence (user_name, online, last_seen_at, updated_at)
            VALUES (%s, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_name)
            DO UPDATE SET
                online = TRUE,
                last_seen_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user,),
        )
    else:
        cursor.execute(
            """
            INSERT INTO chat_presence (user_name, online, last_seen_at, updated_at)
            VALUES (%s, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_name)
            DO UPDATE SET
                online = FALSE,
                last_seen_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user,),
        )


def _touch_conversation_open(cursor, conv_id: int, user: str):
    """
    Opening/reading a chat clears per-user mark-unread and records last opened time.
    Does not alter archive/mute/pin.
    """
    cursor.execute(
        """
        INSERT INTO chat_conversation_prefs (
            conversation_id,
            user_name,
            archived,
            muted,
            pinned,
            pinned_at,
            muted_until,
            last_opened_at,
            mark_unread,
            updated_at
        )
        VALUES (%s, %s, FALSE, FALSE, FALSE, NULL, NULL, CURRENT_TIMESTAMP, FALSE, CURRENT_TIMESTAMP)
        ON CONFLICT (conversation_id, user_name)
        DO UPDATE SET
            last_opened_at = CURRENT_TIMESTAMP,
            mark_unread = FALSE,
            updated_at = CURRENT_TIMESTAMP
        """,
        (conv_id, user),
    )


def _record_delivery(cursor, conv_id: int, user_name: str, msg_id: int):
    """
    Mark that a message was delivered to a user's live socket.
    Delivery is separate from read. Read implies delivered.
    """
    cursor.execute(
        """
        INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
        VALUES (%s, %s, 0, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (conversation_id, user_name)
        DO UPDATE SET
            last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_delivered_id),
            updated_at = CURRENT_TIMESTAMP
        """,
        (conv_id, user_name, msg_id),
    )


def _cursors_for_conv(cursor, conv_id: int):
    cursor.execute(
        """
        SELECT user_name, last_read_id, last_delivered_id
        FROM chat_reads
        WHERE conversation_id = %s
        """,
        (conv_id,),
    )

    read_cursors: dict[str, int] = {}
    delivered_cursors: dict[str, int] = {}

    for row in cursor.fetchall():
        read_cursors[row["user_name"]] = int(row["last_read_id"] or 0)
        delivered_cursors[row["user_name"]] = int(row["last_delivered_id"] or 0)

    return read_cursors, delivered_cursors


def _clean_message(row):
    if row is None:
        return None

    row = dict(row)
    row = _localize(row, "created_at", "edited_at")

    if isinstance(row.get("meta"), str):
        try:
            row["meta"] = json.loads(row["meta"])
        except Exception:
            row["meta"] = {}
    if row.get("meta") is None:
        row["meta"] = {}

    if isinstance(row.get("reactions"), str):
        try:
            row["reactions"] = json.loads(row["reactions"])
        except Exception:
            row["reactions"] = []
    if row.get("reactions") is None:
        row["reactions"] = []

    return row


_MESSAGE_SELECT_FIELDS = """
    SELECT m.id, m.conversation_id, m.sender, m.kind, m.body,
           m.reply_to_id, m.forwarded_from_id, m.meta,
           m.edited_at,
           m.created_at,
           p.display_name AS sender_display,
           p.avatar_url   AS sender_avatar,
           u.tier         AS sender_tier,
           CASE WHEN rp.deleted_at IS NULL THEN rp.body ELSE NULL END AS reply_to_body,
           CASE WHEN rp.deleted_at IS NULL THEN rp.kind ELSE NULL END AS reply_to_kind,
           CASE WHEN rp.deleted_at IS NULL THEN rp.sender ELSE NULL END AS reply_to_sender,
           CASE WHEN rp.deleted_at IS NULL THEN COALESCE(prp.display_name, rpu.username) ELSE NULL END AS reply_to_sender_display,
           COALESCE((
               SELECT json_agg(
                   json_build_object(
                       'emoji', sub.emoji,
                       'count', sub.c,
                       'viewer_reacted', sub.viewer_reacted
                   )
                   ORDER BY sub.c DESC, sub.emoji
               )
               FROM (
                   SELECT r.emoji,
                          COUNT(*)::int AS c,
                          BOOL_OR(r.user_name = %s) AS viewer_reacted
                   FROM chat_reactions r
                   WHERE r.message_id = m.id
                   GROUP BY r.emoji
               ) sub
           ), '[]'::json) AS reactions,
           EXISTS(
               SELECT 1
               FROM chat_starred_messages s
               WHERE s.message_id = m.id
                 AND s.user_name = %s
           ) AS starred_by_viewer
    FROM chat_messages m
    JOIN users u ON u.username = m.sender
    LEFT JOIN profiles p ON p.user_id = u.id
    LEFT JOIN chat_messages rp ON rp.id = m.reply_to_id
    LEFT JOIN users rpu ON rpu.username = rp.sender
    LEFT JOIN profiles prp ON prp.user_id = rpu.id
"""


def _message_row(cursor, msg_id: int, viewer: str = ""):
    cursor.execute(
        _MESSAGE_SELECT_FIELDS + " WHERE m.id = %s",
        (viewer, viewer, msg_id),
    )
    return _clean_message(cursor.fetchone())


def _message_rows(cursor, ids: list[int], viewer: str = ""):
    if not ids:
        return []

    cursor.execute(
        _MESSAGE_SELECT_FIELDS + " WHERE m.id = ANY(%s) ORDER BY m.id ASC",
        (viewer, viewer, ids),
    )

    return [_clean_message(r) for r in cursor.fetchall()]


def _insert_message(
    cursor,
    conv_id: int,
    sender: str,
    kind: str,
    body: str,
    reply_to_id: int | None = None,
    forwarded_from_id: int | None = None,
    meta: dict | None = None,
):
    if kind not in MESSAGE_KINDS:
        raise ValueError("invalid message kind")

    body = (body or "").strip()
    if not body:
        raise ValueError("message body required")

    if reply_to_id is not None:
        cursor.execute(
            """
            SELECT 1
            FROM chat_messages
            WHERE id = %s
              AND conversation_id = %s
              AND deleted_at IS NULL
            """,
            (reply_to_id, conv_id),
        )
        if cursor.fetchone() is None:
            raise ValueError("reply target not found")

    if forwarded_from_id is not None:
        cursor.execute("SELECT 1 FROM chat_messages WHERE id = %s", (forwarded_from_id,))
        if cursor.fetchone() is None:
            raise ValueError("forward source not found")

    if not isinstance(meta, dict):
        meta = {}

    if kind == "text":
        links = _extract_links(body)
        if links:
            meta = {**meta, "links": links}

    meta_json = json.dumps(meta, default=str)

    cursor.execute(
        """
        INSERT INTO chat_messages (
            conversation_id,
            sender,
            kind,
            body,
            reply_to_id,
            forwarded_from_id,
            meta
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        RETURNING id
        """,
        (conv_id, sender, kind, body, reply_to_id, forwarded_from_id, meta_json),
    )

    msg_id = cursor.fetchone()["id"]

    cursor.execute(
        "UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = %s",
        (conv_id,),
    )

    return msg_id


async def _broadcast_message(row: dict, conv_id: int, sender: str, sender_ws: WebSocket | None = None):
    if not row:
        return

    members = set(_member_names_from_id(conv_id))
    msg_id = row["id"]

    # Do not leak the sender's personal starred/reaction state to other recipients.
    broadcast_row = dict(row)
    broadcast_row["starred_by_viewer"] = False

    if isinstance(broadcast_row.get("reactions"), list):
        broadcast_row["reactions"] = [
            {**x, "viewer_reacted": False}
            for x in broadcast_row["reactions"]
        ]

    payload = json.dumps({"type": "message", "message": broadcast_row}, default=str)
    delivered = await manager.send_to_users(members, payload, exclude=sender_ws)

    recipient_deliveries = delivered - {sender}

    # Record live delivery receipts for recipients who were online.
    if recipient_deliveries:
        conn = get_db()
        cursor = conn.cursor()

        try:
            for u in recipient_deliveries:
                _record_delivery(cursor, conv_id, u, msg_id)
            conn.commit()
        except Exception:
            conn.rollback()
        finally:
            conn.close()

        # Tell the sender's sockets which recipients received it.
        for u in recipient_deliveries:
            frame = json.dumps({
                "type": "delivery",
                "conversation_id": conv_id,
                "user_name": u,
                "last_delivered_id": msg_id,
            }, default=str)

            # Current sender tab.
            if sender_ws is not None:
                try:
                    await sender_ws.send_text(frame)
                except Exception:
                    pass

            # Other sender tabs.
            await manager.send_to_users([sender], frame, exclude=sender_ws)

    # Who was @-mentioned in a text message (members only, never the sender).
    mentioned: set[str] = set()
    if row.get("kind") == "text":
        tokens = {t.lower() for t in re.findall(r"@([A-Za-z0-9_.\-]+)", row.get("body") or "")}
        if tokens:
            lower_members = {m.lower(): m for m in members if m != sender}
            for tk in tokens:
                if tk in lower_members:
                    mentioned.add(lower_members[tk])

    undelivered = members - delivered - {sender}

    # Mentioned members get a dedicated mention notification, not a generic message one.
    generic_targets = undelivered - mentioned

    kind = row.get("kind")
    if kind == "text":
        preview = (row.get("body") or "")[:120]
    elif kind == "image":
        preview = "Photo"
    elif kind == "voice":
        preview = "Voice note"
    elif kind == "video":
        preview = "Video"
    elif kind == "file":
        preview = "File"
    elif kind == "location":
        preview = "Location"
    elif kind == "contact":
        preview = "Contact"
    else:
        preview = "New message"

    title = row.get("sender_display") or sender

    if generic_targets or mentioned:
        conn = get_db()
        cursor = conn.cursor()

        try:
            def _muted(user: str) -> bool:
                cursor.execute(
                    """
                    SELECT 1
                    FROM chat_conversation_prefs
                    WHERE conversation_id = %s
                      AND user_name = %s
                      AND muted = TRUE
                      AND (muted_until IS NULL OR muted_until > CURRENT_TIMESTAMP)
                    """,
                    (conv_id, user),
                )
                return cursor.fetchone() is not None

            for u in generic_targets:
                if _muted(u):
                    continue

                create_notification(
                    user_name=u,
                    category="messages",
                    type="chat_message",
                    legacy_type="message",
                    title=title,
                    body=preview,
                    actor=sender,
                    source_type="conversation",
                    source_id=conv_id,
                    secondary_id=msg_id,
                    data={"conversation_id": conv_id, "message_id": msg_id},
                    cursor=cursor,
                )

            # Mentions fire even when live-delivered: being tagged is worth surfacing.
            for u in mentioned:
                if _muted(u):
                    continue

                create_notification(
                    user_name=u,
                    category="mentions",
                    type="chat_mention",
                    legacy_type="mention",
                    title=title,
                    body=preview,
                    actor=sender,
                    source_type="conversation",
                    source_id=conv_id,
                    secondary_id=msg_id,
                    data={"conversation_id": conv_id, "message_id": msg_id},
                    cursor=cursor,
                )

            conn.commit()
        except Exception:
            conn.rollback()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Group join requests and group management policy
# ---------------------------------------------------------------------------
GROUP_JOIN_MODES = {"open", "request", "invite", "private"}


def _group_role(cursor, conv_id: int, user: str) -> str | None:
    cursor.execute(
        """
        SELECT role
        FROM chat_members
        WHERE conversation_id = %s
          AND user_name = %s
        """,
        (conv_id, user),
    )
    row = cursor.fetchone()
    return row["role"] if row else None


def _can_manage_group(cursor, conv_id: int, user: str) -> bool:
    role = _group_role(cursor, conv_id, user)
    return role in {"owner", "admin"}


def _group_admins(cursor, conv_id: int) -> list[str]:
    cursor.execute(
        """
        SELECT user_name
        FROM chat_members
        WHERE conversation_id = %s
          AND role IN ('owner', 'admin')
        """,
        (conv_id,),
    )
    return [r["user_name"] for r in cursor.fetchall()]


def _notify_group_admins(
    cursor,
    conv_id: int,
    type: str,
    title: str,
    body: str,
    actor: str | None = None,
    secondary_id: int | None = None,
):
    admins = _group_admins(cursor, conv_id)

    for admin in admins:
        if admin == actor:
            continue

        create_notification(
            user_name=admin,
            category="groups",
            type=type,
            title=title,
            body=body,
            actor=actor,
            source_type="conversation",
            source_id=conv_id,
            secondary_id=secondary_id,
            data={"conversation_id": conv_id},
            cursor=cursor,
        )


@router.post("/chat/conversations/{conv_id}/join-request")
def request_group_join(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    message = (data.get("message") or "").strip()[:300] or None

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            """
            SELECT kind, join_mode
            FROM chat_conversations
            WHERE id = %s
            """,
            (conv_id,),
        )
        conv = cursor.fetchone()

        if not conv:
            conn.rollback()
            return {"error": "conversation not found"}

        if conv["kind"] != "group":
            conn.rollback()
            return {"error": "not a group"}

        if _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "already a member"}

        join_mode = conv.get("join_mode") or "request"

        if join_mode == "open":
            cursor.execute(
                """
                INSERT INTO chat_members (conversation_id, user_name, role)
                VALUES (%s, %s, 'member')
                ON CONFLICT DO NOTHING
                """,
                (conv_id, viewer),
            )

            cursor.execute(
                """
                UPDATE group_join_requests
                SET status = 'approved',
                    reviewed_by = %s,
                    reviewed_at = CURRENT_TIMESTAMP
                WHERE group_id = %s
                  AND user_name = %s
                  AND status = 'pending'
                """,
                (viewer, conv_id, viewer),
            )

            conn.commit()
            return {"message": "joined group", "status": "joined"}

        if join_mode == "private":
            conn.rollback()
            return {"error": "this group is private"}

        if join_mode == "invite":
            conn.rollback()
            return {"error": "this group requires an invitation"}

        cursor.execute(
            """
            SELECT status
            FROM group_join_requests
            WHERE group_id = %s
              AND user_name = %s
            """,
            (conv_id, viewer),
        )
        existing = cursor.fetchone()

        if existing and existing["status"] == "pending":
            conn.rollback()
            return {"error": "your request is already pending"}

        if existing and existing["status"] == "approved":
            conn.rollback()
            return {"error": "your request was already approved"}

        cursor.execute(
            """
            INSERT INTO group_join_requests (
                group_id,
                user_name,
                status,
                message,
                created_at
            )
            VALUES (%s, %s, 'pending', %s, CURRENT_TIMESTAMP)
            ON CONFLICT (group_id, user_name)
            DO UPDATE SET
                status = 'pending',
                message = EXCLUDED.message,
                reviewed_by = NULL,
                reviewed_at = NULL,
                created_at = CURRENT_TIMESTAMP
            """,
            (conv_id, viewer, message),
        )

        cursor.execute(
            """
            SELECT COALESCE(p.display_name, u.username) AS display_name
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.username = %s
            """,
            (viewer,),
        )
        requester = cursor.fetchone()
        requester_name = (requester or {}).get("display_name") or viewer

        cursor.execute("SELECT name FROM chat_conversations WHERE id = %s", (conv_id,))
        group = cursor.fetchone()
        group_name = (group or {}).get("name") or "the group"

        _notify_group_admins(
            cursor=cursor,
            conv_id=conv_id,
            type="group_join_request",
            title=f"{requester_name} requested to join {group_name}",
            body=message or "",
            actor=viewer,
        )

        conn.commit()
        return {"message": "join request sent", "status": "pending"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# REST: discover groups
# ---------------------------------------------------------------------------
@router.get("/chat/discover")
def discover_groups(viewer: str = "", q: str = "", limit: int = 30):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(limit, 50))
    query = (q or "").strip()
    search = f"%{query}%" if query else None

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT c.id,
               c.name,
               c.image_url,
               c.description,
               c.join_mode,
               (
                   SELECT COUNT(*)
                   FROM chat_members cm
                   WHERE cm.conversation_id = c.id
               ) AS member_count,
               COALESCE(gjr.status, 'none') AS request_status
        FROM chat_conversations c
        LEFT JOIN group_join_requests gjr
               ON gjr.group_id = c.id
              AND gjr.user_name = %s
        WHERE c.kind = 'group'
          AND c.join_mode IN ('open', 'request')
          AND NOT EXISTS (
              SELECT 1
              FROM chat_members cm2
              WHERE cm2.conversation_id = c.id
                AND cm2.user_name = %s
          )
          AND (
              %s::text IS NULL
              OR c.name ILIKE %s
              OR COALESCE(c.description, '') ILIKE %s
          )
        ORDER BY c.updated_at DESC NULLS LAST,
                 c.id DESC
        LIMIT %s
        """,
        (
            viewer,
            viewer,
            search,
            search,
            search,
            limit,
        ),
    )

    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    return {"groups": rows}

@router.get("/chat/conversations/{conv_id}/join-requests")
def list_group_join_requests(conv_id: int, viewer: str = "", status: str = "pending"):
    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer)
        if not viewer:
            return {"error": "viewer required"}

        if not _can_manage_group(cursor, conv_id, viewer):
            return {"error": "not allowed"}

        if status not in {"pending", "approved", "rejected", "cancelled", "all"}:
            status = "pending"

        if status == "all":
            cursor.execute(
                """
                SELECT r.id,
                       r.user_name,
                       r.status,
                       r.message,
                       r.created_at,
                       r.reviewed_at,
                       COALESCE(p.display_name, u.username) AS display_name,
                       p.avatar_url
                FROM group_join_requests r
                JOIN users u ON u.username = r.user_name
                LEFT JOIN profiles p ON p.user_id = u.id
                WHERE r.group_id = %s
                ORDER BY r.created_at DESC
                """,
                (conv_id,),
            )
        else:
            cursor.execute(
                """
                SELECT r.id,
                       r.user_name,
                       r.status,
                       r.message,
                       r.created_at,
                       r.reviewed_at,
                       COALESCE(p.display_name, u.username) AS display_name,
                       p.avatar_url
                FROM group_join_requests r
                JOIN users u ON u.username = r.user_name
                LEFT JOIN profiles p ON p.user_id = u.id
                WHERE r.group_id = %s
                  AND r.status = %s
                ORDER BY r.created_at DESC
                """,
                (conv_id, status),
            )

        rows = [dict(r) for r in cursor.fetchall()]

        for r in rows:
            for key in ("created_at", "reviewed_at"):
                if r.get(key) and hasattr(r[key], "isoformat"):
                    r[key] = r[key].isoformat()

        return {"requests": rows}

    finally:
        conn.close()


@router.post("/chat/conversations/{conv_id}/join-requests/{request_id}/approve")
def approve_group_join_request(conv_id: int, request_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not _can_manage_group(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not allowed"}

        cursor.execute(
            """
            SELECT id, user_name, status
            FROM group_join_requests
            WHERE id = %s
              AND group_id = %s
            FOR UPDATE
            """,
            (request_id, conv_id),
        )
        request = cursor.fetchone()

        if not request:
            conn.rollback()
            return {"error": "request not found"}

        if request["status"] != "pending":
            conn.rollback()
            return {"error": "request is not pending"}

        target = request["user_name"]

        cursor.execute(
            """
            INSERT INTO chat_members (conversation_id, user_name, role)
            VALUES (%s, %s, 'member')
            ON CONFLICT DO NOTHING
            """,
            (conv_id, target),
        )

        cursor.execute(
            """
            UPDATE group_join_requests
            SET status = 'approved',
                reviewed_by = %s,
                reviewed_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (viewer, request_id),
        )

        cursor.execute(
            """
            SELECT COALESCE(p.display_name, u.username) AS display_name
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.username = %s
            """,
            (viewer,),
        )
        approver = cursor.fetchone()
        approver_name = (approver or {}).get("display_name") or viewer

        cursor.execute("SELECT name FROM chat_conversations WHERE id = %s", (conv_id,))
        group = cursor.fetchone()
        group_name = (group or {}).get("name") or "the group"

        create_notification(
            user_name=target,
            category="groups",
            type="group_request_approved",
            title=f"Your request to join {group_name} was approved",
            body=f"{approver_name} approved your request.",
            actor=viewer,
            source_type="conversation",
            source_id=conv_id,
            data={"conversation_id": conv_id},
            cursor=cursor,
        )

        cursor.execute(
            """
            SELECT announce_new_members
            FROM chat_conversations
            WHERE id = %s
            """,
            (conv_id,),
        )
        conv = cursor.fetchone()

        if conv and conv.get("announce_new_members"):
            cursor.execute(
                """
                SELECT COALESCE(p.display_name, u.username) AS display_name
                FROM users u
                LEFT JOIN profiles p ON p.user_id = u.id
                WHERE u.username = %s
                """,
                (target,),
            )
            joined = cursor.fetchone()
            joined_name = (joined or {}).get("display_name") or target

            _insert_message(
                cursor=cursor,
                conv_id=conv_id,
                sender=viewer,
                kind="system",
                body=f"{joined_name} joined the group",
            )

        conn.commit()
        return {"message": "request approved"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/chat/conversations/{conv_id}/join-requests/{request_id}/reject")
def reject_group_join_request(conv_id: int, request_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not _can_manage_group(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not allowed"}

        cursor.execute(
            """
            SELECT id, user_name, status
            FROM group_join_requests
            WHERE id = %s
              AND group_id = %s
            FOR UPDATE
            """,
            (request_id, conv_id),
        )
        request = cursor.fetchone()

        if not request:
            conn.rollback()
            return {"error": "request not found"}

        if request["status"] != "pending":
            conn.rollback()
            return {"error": "request is not pending"}

        target = request["user_name"]

        cursor.execute(
            """
            UPDATE group_join_requests
            SET status = 'rejected',
                reviewed_by = %s,
                reviewed_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (viewer, request_id),
        )

        cursor.execute("SELECT name FROM chat_conversations WHERE id = %s", (conv_id,))
        group = cursor.fetchone()
        group_name = (group or {}).get("name") or "the group"

        create_notification(
            user_name=target,
            category="groups",
            type="group_request_rejected",
            title=f"Your request to join {group_name} was declined",
            body="",
            actor=viewer,
            source_type="conversation",
            source_id=conv_id,
            data={"conversation_id": conv_id},
            cursor=cursor,
        )

        conn.commit()
        return {"message": "request rejected"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.delete("/chat/conversations/{conv_id}/join-request")
def cancel_group_join_request(conv_id: int, viewer: str = ""):
    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer)
        if not viewer:
            conn.rollback()
            return {"error": "viewer required"}

        cursor.execute(
            """
            UPDATE group_join_requests
            SET status = 'cancelled'
            WHERE group_id = %s
              AND user_name = %s
              AND status = 'pending'
            """,
            (conv_id, viewer),
        )

        if cursor.rowcount == 0:
            conn.rollback()
            return {"error": "no pending request found"}

        conn.commit()
        return {"message": "request cancelled"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


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
    if viewer:
        _set_presence(cursor, viewer, True)
        conn.commit()
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

                try:
                    reply_to_id = _optional_int(data.get("reply_to_id"))
                    forwarded_from_id = _optional_int(data.get("forwarded_from_id"))
                except Exception:
                    await websocket.send_text(
                        json.dumps({
                            "type": "error",
                            "temp_id": temp_id,
                            "conversation_id": conv_id,
                            "error": "invalid message id",
                        })
                    )
                    continue

                meta = data.get("meta") or {}
                if not isinstance(meta, dict):
                    meta = {}

                if conv_id is None or kind not in USER_KINDS or not body:
                    await websocket.send_text(
                        json.dumps({
                            "type": "error",
                            "temp_id": temp_id,
                            "conversation_id": conv_id,
                            "error": "invalid message",
                        })
                    )
                    continue

                conn = get_db()
                cursor = conn.cursor()

                try:
                    if not _is_member(cursor, conv_id, viewer):
                        await websocket.send_text(
                            json.dumps({
                                "type": "error",
                                "temp_id": temp_id,
                                "conversation_id": conv_id,
                                "error": "not a member",
                            })
                        )
                        continue

                    if _is_blocked_direct(cursor, conv_id, viewer):
                        await websocket.send_text(
                            json.dumps({
                                "type": "error",
                                "temp_id": temp_id,
                                "conversation_id": conv_id,
                                "error": "this chat is blocked",
                            })
                        )
                        continue

                    msg_id = _insert_message(
                        cursor=cursor,
                        conv_id=conv_id,
                        sender=viewer,
                        kind=kind,
                        body=body,
                        reply_to_id=reply_to_id,
                        forwarded_from_id=forwarded_from_id,
                        meta=meta,
                    )

                    row = _message_row(cursor, msg_id, viewer)
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    await websocket.send_text(
                        json.dumps({
                            "type": "error",
                            "temp_id": temp_id,
                            "conversation_id": conv_id,
                            "error": str(e),
                        })
                    )
                    continue
                finally:
                    conn.close()

                if row is None:
                    await websocket.send_text(
                        json.dumps({
                            "type": "error",
                            "temp_id": temp_id,
                            "conversation_id": conv_id,
                            "error": "message not found after insert",
                        })
                    )
                    continue

                # Ack the sending tab so it can replace its optimistic bubble.
                await websocket.send_text(
                    json.dumps({"type": "ack", "temp_id": temp_id, "message": row}, default=str)
                )

                await _broadcast_message(row, conv_id, viewer, sender_ws=websocket)

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
                        """
                        INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
                        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT (conversation_id, user_name)
                        DO UPDATE SET
                            last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id),
                            last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_read_id),
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (conv_id, viewer, last_id, last_id),
                    )

                    _touch_conversation_open(cursor, conv_id, viewer)
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
                    }, default=str),
                    exclude=websocket,
                )

            # ---- typing ----
            elif ctype == "typing":
                conv_id = data.get("conversation_id")

                if conv_id is None:
                    continue

                conn = get_db()
                cursor = conn.cursor()
                member = _is_member(cursor, conv_id, viewer)
                conn.close()

                if not member:
                    continue

                members = _member_names_from_id(conv_id)
                await manager.send_to_users(
                    members,
                    json.dumps({
                        "type": "typing",
                        "conversation_id": conv_id,
                        "user_name": viewer,
                    }, default=str),
                    exclude=websocket,
                )

            # ---- recording voice note ----
            elif ctype == "recording":
                conv_id = data.get("conversation_id")
                active = bool(data.get("active", False))

                if conv_id is None:
                    continue

                conn = get_db()
                cursor = conn.cursor()
                member = _is_member(cursor, conv_id, viewer)
                conn.close()

                if not member:
                    continue

                members = _member_names_from_id(conv_id)
                await manager.send_to_users(
                    members,
                    json.dumps({
                        "type": "recording",
                        "conversation_id": conv_id,
                        "user_name": viewer,
                        "active": active,
                    }, default=str),
                    exclude=websocket,
                )

            else:
                await websocket.send_text(
                    json.dumps({"type": "error", "error": f"unknown type {ctype}"})
                )

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        try:
            conn = get_db()
            cursor = conn.cursor()
            _set_presence(cursor, viewer, False)
            conn.commit()
            conn.close()
        except Exception:
            pass

        await manager.disconnect(viewer, websocket)


# ---------------------------------------------------------------------------
# REST: conversation list
# ---------------------------------------------------------------------------
@router.get("/chat/conversations")
def list_conversations(viewer: str = "", include_archived: bool = False):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT c.id, c.kind, c.name, c.image_url, c.description,
               c.join_mode,
               c.allow_member_invites,
               c.announce_new_members,
               c.updated_at,

               COALESCE(p.archived, FALSE) AS archived,

               CASE
                   WHEN COALESCE(p.muted, FALSE)
                        AND (p.muted_until IS NULL OR p.muted_until > CURRENT_TIMESTAMP)
                   THEN TRUE
                   ELSE FALSE
               END AS muted,

               COALESCE(p.pinned, FALSE) AS pinned,
               p.pinned_at,
               COALESCE(p.mark_unread, FALSE) AS mark_unread,
               d.body AS draft,

               lm.body AS last_body,
               lm.kind AS last_kind,
               lm.sender AS last_sender,
               lm.created_at AS last_at,

               (
                   SELECT COUNT(*)
                   FROM chat_messages m
                   WHERE m.conversation_id = c.id
                     AND m.sender <> %s
                     AND m.deleted_at IS NULL
                     AND NOT EXISTS (
                         SELECT 1
                         FROM chat_message_hidden h
                         WHERE h.message_id = m.id
                           AND h.user_name = %s
                     )
                     AND (
                         COALESCE(p.mark_unread, FALSE)
                         OR m.id > COALESCE((
                             SELECT r.last_read_id
                             FROM chat_reads r
                             WHERE r.conversation_id = c.id
                               AND r.user_name = %s
                         ), 0)
                     )
               ) AS unread,

               CASE WHEN c.kind = 'direct' THEN cp.display_name ELSE NULL END AS counterpart,
               CASE WHEN c.kind = 'direct' THEN cp.avatar_url ELSE NULL END AS counterpart_avatar,
               CASE WHEN c.kind = 'direct' THEN cp.username ELSE NULL END AS counterpart_username,
               CASE WHEN c.kind = 'direct' THEN cp.online ELSE NULL END AS counterpart_online,
               CASE WHEN c.kind = 'direct' THEN cp.last_seen_at ELSE NULL END AS counterpart_last_seen_at,

               (
                   SELECT COUNT(*)
                   FROM chat_members cmc
                   WHERE cmc.conversation_id = c.id
               ) AS member_count

        FROM chat_conversations c
        LEFT JOIN chat_conversation_prefs p
               ON p.conversation_id = c.id
              AND p.user_name = %s
        LEFT JOIN chat_drafts d
               ON d.conversation_id = c.id
              AND d.user_name = %s
        LEFT JOIN LATERAL (
            SELECT m.id, m.body, m.kind, m.sender, m.created_at
            FROM chat_messages m
            WHERE m.conversation_id = c.id
              AND m.deleted_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM chat_message_hidden h
                  WHERE h.message_id = m.id
                    AND h.user_name = %s
              )
            ORDER BY m.id DESC
            LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
            SELECT COALESCE(p2.display_name, u2.username) AS display_name,
                   p2.avatar_url,
                   u2.username AS username,
                   COALESCE(pr2.online, FALSE) AS online,
                   pr2.last_seen_at
            FROM chat_members cm2
            JOIN users u2 ON u2.username = cm2.user_name
            LEFT JOIN profiles p2 ON p2.user_id = u2.id
            LEFT JOIN chat_presence pr2 ON pr2.user_name = u2.username
            WHERE cm2.conversation_id = c.id
              AND cm2.user_name <> %s
            LIMIT 1
        ) cp ON TRUE
        WHERE c.id IN (
            SELECT conversation_id
            FROM chat_members
            WHERE user_name = %s
        )
          AND (%s::boolean OR COALESCE(p.archived, FALSE) = FALSE)
        ORDER BY COALESCE(p.pinned, FALSE) DESC,
                 p.pinned_at DESC NULLS LAST,
                 lm.created_at DESC NULLS LAST,
                 c.id DESC
        """,
        (
            viewer,  # unread sender
            viewer,  # unread hidden
            viewer,  # unread last_read
            viewer,  # prefs
            viewer,  # draft
            viewer,  # last message hidden
            viewer,  # counterpart other
            viewer,  # membership
            include_archived,
        ),
    )

    rows = [dict(r) for r in cursor.fetchall()]

    for r in rows:
        _localize(r, "updated_at", "pinned_at", "last_at", "counterpart_last_seen_at")

    conn.close()
    return {"conversations": rows}


# ---------------------------------------------------------------------------
# REST: starred messages
# ---------------------------------------------------------------------------
@router.get("/chat/starred")
def list_starred_messages(viewer: str = "", limit: int = 100):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(limit, 200))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT m.id
        FROM chat_starred_messages s
        JOIN chat_messages m ON m.id = s.message_id
        WHERE s.user_name = %s
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM chat_message_hidden h
              WHERE h.message_id = m.id
                AND h.user_name = %s
          )
          AND m.conversation_id IN (
              SELECT conversation_id
              FROM chat_members
              WHERE user_name = %s
          )
        ORDER BY m.id DESC
        LIMIT %s
        """,
        (viewer, viewer, viewer, limit),
    )

    ids = [r["id"] for r in cursor.fetchall()]
    messages = _message_rows(cursor, ids, viewer)
    messages.reverse()

    conn.close()
    return {"messages": messages}


# ---------------------------------------------------------------------------
# REST: pinned messages
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/pinned")
def list_pinned_messages(conv_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    if not _is_member(cursor, conv_id, viewer):
        conn.close()
        return {"error": "not a member"}

    cursor.execute(
        """
        SELECT m.id
        FROM chat_messages m
        WHERE m.conversation_id = %s
          AND m.deleted_at IS NULL
          AND m.meta ? 'pinned_at'
        ORDER BY (m.meta->>'pinned_at')::bigint DESC NULLS LAST
        LIMIT 20
        """,
        (conv_id,),
    )

    ids = [r["id"] for r in cursor.fetchall()]
    messages = _message_rows(cursor, ids, viewer)
    messages.reverse()

    conn.close()
    return {"messages": messages}


@router.post("/chat/messages/{message_id}/unpin")
def unpin_message(message_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            "SELECT conversation_id FROM chat_messages WHERE id = %s AND deleted_at IS NULL",
            (message_id,),
        )
        row = cursor.fetchone()

        if not row:
            conn.rollback()
            return {"error": "message not found"}

        conv_id = row["conversation_id"]

        if not _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not a member"}

        cursor.execute(
            """
            UPDATE chat_messages
            SET meta = COALESCE(meta, '{}'::jsonb) - 'pinned_at' - 'pinned_by'
            WHERE id = %s
            """,
            (message_id,),
        )

        message = _message_row(cursor, message_id, viewer)
        conn.commit()
        return {"message": message}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/chat/messages/{message_id}/unpin")
def unpin_message(message_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            "SELECT conversation_id FROM chat_messages WHERE id = %s AND deleted_at IS NULL",
            (message_id,),
        )
        row = cursor.fetchone()

        if not row:
            conn.rollback()
            return {"error": "message not found"}

        conv_id = row["conversation_id"]

        if not _is_member(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "not a member"}

        cursor.execute(
            """
            UPDATE chat_messages
            SET meta = COALESCE(meta, '{}'::jsonb) - 'pinned_at' - 'pinned_by'
            WHERE id = %s
            """,
            (message_id,),
        )

        message = _message_row(cursor, message_id, viewer)
        conn.commit()
        return {"message": message}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: reaction detail
# ---------------------------------------------------------------------------
@router.get("/chat/messages/{message_id}/reactions")
def message_reaction_detail(message_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        "SELECT conversation_id FROM chat_messages WHERE id = %s AND deleted_at IS NULL",
        (message_id,),
    )
    row = cursor.fetchone()

    if not row:
        conn.close()
        return {"error": "message not found"}

    if not _is_member(cursor, row["conversation_id"], viewer):
        conn.close()
        return {"error": "not a member"}

    cursor.execute(
        """
        SELECT r.emoji,
               r.user_name,
               COALESCE(p.display_name, u.username) AS display_name,
               p.avatar_url
        FROM chat_reactions r
        JOIN users u ON u.username = r.user_name
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE r.message_id = %s
        ORDER BY r.emoji, COALESCE(p.display_name, u.username)
        """,
        (message_id,),
    )

    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    return {"reactions": rows}


# ---------------------------------------------------------------------------
# REST: clear chat for me
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/clear")
def clear_conversation_for_me(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
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
            """
            INSERT INTO chat_message_hidden (message_id, user_name)
            SELECT m.id, %s
            FROM chat_messages m
            WHERE m.conversation_id = %s
              AND NOT EXISTS (
                  SELECT 1
                  FROM chat_message_hidden h
                  WHERE h.message_id = m.id
                    AND h.user_name = %s
              )
            ON CONFLICT (message_id, user_name) DO NOTHING
            """,
            (viewer, conv_id, viewer),
        )

        hidden = cursor.rowcount
        conn.commit()
        return {"hidden": hidden}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: mark all chats read
# ---------------------------------------------------------------------------
@router.post("/chat/read-all")
def mark_all_chats_read(data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            """
            INSERT INTO chat_reads (
                conversation_id,
                user_name,
                last_read_id,
                last_delivered_id,
                updated_at
            )
            SELECT cm.conversation_id,
                   %s,
                   COALESCE(mx.max_id, 0),
                   COALESCE(mx.max_id, 0),
                   CURRENT_TIMESTAMP
            FROM chat_members cm
            LEFT JOIN LATERAL (
                SELECT MAX(m.id) AS max_id
                FROM chat_messages m
                WHERE m.conversation_id = cm.conversation_id
                  AND m.deleted_at IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM chat_message_hidden h
                      WHERE h.message_id = m.id
                        AND h.user_name = %s
                  )
            ) mx ON TRUE
            WHERE cm.user_name = %s
            ON CONFLICT (conversation_id, user_name)
            DO UPDATE SET
                last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id),
                last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_delivered_id),
                updated_at = CURRENT_TIMESTAMP
            """,
            (viewer, viewer, viewer),
        )

        conn.commit()
        return {"message": "all chats marked read"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: mute with duration
# hours = null  -> mute always
# hours = 0     -> unmute
# hours = number -> mute for N hours
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/mute")
def mute_conversation_endpoint(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    hours = data.get("hours", None)

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

        if hours is None:
            cursor.execute(
                """
                INSERT INTO chat_conversation_prefs (
                    conversation_id,
                    user_name,
                    archived,
                    muted,
                    pinned,
                    pinned_at,
                    muted_until,
                    last_opened_at,
                    mark_unread,
                    updated_at
                )
                VALUES (%s, %s, FALSE, TRUE, FALSE, NULL, NULL, CURRENT_TIMESTAMP, FALSE, CURRENT_TIMESTAMP)
                ON CONFLICT (conversation_id, user_name)
                DO UPDATE SET
                    muted = TRUE,
                    muted_until = NULL,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (conv_id, viewer),
            )
        else:
            try:
                h = float(hours)
            except Exception:
                conn.rollback()
                return {"error": "invalid hours"}

            if h <= 0:
                cursor.execute(
                    """
                    INSERT INTO chat_conversation_prefs (
                        conversation_id,
                        user_name,
                        archived,
                        muted,
                        pinned,
                        pinned_at,
                        muted_until,
                        last_opened_at,
                        mark_unread,
                        updated_at
                    )
                    VALUES (%s, %s, FALSE, FALSE, FALSE, NULL, NULL, CURRENT_TIMESTAMP, FALSE, CURRENT_TIMESTAMP)
                    ON CONFLICT (conversation_id, user_name)
                    DO UPDATE SET
                        muted = FALSE,
                        muted_until = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (conv_id, viewer),
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO chat_conversation_prefs (
                        conversation_id,
                        user_name,
                        archived,
                        muted,
                        pinned,
                        pinned_at,
                        muted_until,
                        last_opened_at,
                        mark_unread,
                        updated_at
                    )
                    VALUES (%s, %s, FALSE, TRUE, FALSE, NULL, CURRENT_TIMESTAMP + make_interval(hours => %s), CURRENT_TIMESTAMP, FALSE, CURRENT_TIMESTAMP)
                    ON CONFLICT (conversation_id, user_name)
                    DO UPDATE SET
                        muted = TRUE,
                        muted_until = CURRENT_TIMESTAMP + make_interval(hours => %s),
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (conv_id, viewer, h, h),
                )

        conn.commit()
        return {"message": "mute updated"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


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

            cursor.execute(
                """
                SELECT 1
                FROM chat_blocks
                WHERE (blocker = %s AND blocked = %s)
                   OR (blocker = %s AND blocked = %s)
                """,
                (viewer, target, target, viewer),
            )
            if cursor.fetchone():
                conn.rollback()
                return {"error": "this chat is blocked"}

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

            description = (data.get("description") or "").strip() or None
            image_url = (data.get("image_url") or "").strip() or None

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

            join_mode = (data.get("join_mode") or "request").strip().lower()
            if join_mode not in GROUP_JOIN_MODES:
                join_mode = "request"

            allow_member_invites = bool(data.get("allow_member_invites", False))
            announce_new_members = bool(data.get("announce_new_members", False))

            cursor.execute(
                """
                INSERT INTO chat_conversations (
                    kind,
                    name,
                    image_url,
                    description,
                    created_by,
                    join_mode,
                    allow_member_invites,
                    announce_new_members
                )
                VALUES ('group', %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    name,
                    image_url,
                    description,
                    viewer,
                    join_mode,
                    allow_member_invites,
                    announce_new_members,
                ),
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
                cursor.execute(
                    """
                    INSERT INTO chat_notifications (
                        user_name, conversation_id, message_id, type, title, body
                    )
                    VALUES (%s, %s, NULL, 'group_invite', %s, %s)
                    """,
                    (member, conv_id, name, f"{viewer} added you to the group"),
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
# REST: group members
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/members")
def get_members(conv_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    if not _is_member(cursor, conv_id, viewer):
        conn.close()
        return {"error": "not a member"}

    cursor.execute(
        """
        SELECT cm.user_name,
               cm.role,
               cm.joined_at,
               COALESCE(p.display_name, u.username) AS display_name,
               p.avatar_url,
               u.tier,
               COALESCE(pr.online, FALSE) AS online,
               pr.last_seen_at
        FROM chat_members cm
        JOIN users u ON u.username = cm.user_name
        LEFT JOIN profiles p ON p.user_id = u.id
        LEFT JOIN chat_presence pr ON pr.user_name = cm.user_name
        WHERE cm.conversation_id = %s
        ORDER BY
            CASE cm.role
                WHEN 'owner' THEN 0
                WHEN 'admin' THEN 1
                ELSE 2
            END,
            COALESCE(p.display_name, u.username)
        """,
        (conv_id,),
    )

    rows = [dict(r) for r in cursor.fetchall()]

    for r in rows:
        _localize(r, "joined_at", "last_seen_at")

    conn.close()
    return {"members": rows}


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

        if not _can_manage_group(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "only admins can add members"}

        cursor.execute(
            """
            SELECT 1
            FROM chat_members
            WHERE conversation_id = %s
              AND user_name = %s
            """,
            (conv_id, target),
        )

        already_member = cursor.fetchone() is not None

        if not already_member:
            cursor.execute(
                """
                INSERT INTO chat_members (conversation_id, user_name, role)
                VALUES (%s, %s, 'member')
                ON CONFLICT DO NOTHING
                """,
                (conv_id, target),
            )

        cursor.execute(
            """
            UPDATE group_join_requests
            SET status = 'approved',
                reviewed_by = %s,
                reviewed_at = CURRENT_TIMESTAMP
            WHERE group_id = %s
              AND user_name = %s
              AND status = 'pending'
            """,
            (viewer, conv_id, target),
        )

        cursor.execute("SELECT name FROM chat_conversations WHERE id = %s", (conv_id,))
        grow = cursor.fetchone()
        gname = (grow or {}).get("name") or "a group"

        cursor.execute(
            """
            SELECT COALESCE(p.display_name, u.username) AS display_name
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.username = %s
            """,
            (viewer,),
        )
        inviter = cursor.fetchone()
        inviter_name = (inviter or {}).get("display_name") or viewer

        create_notification(
            user_name=target,
            category="groups",
            type="group_invite",
            legacy_type="group_invite",
            title=f"{inviter_name} added you to {gname}",
            body="",
            actor=viewer,
            source_type="conversation",
            source_id=conv_id,
            data={"conversation_id": conv_id},
            cursor=cursor,
        )

        conn.commit()
        return {"message": "member added"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST: history
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/messages")
def history(
    conv_id: int,
    viewer: str = "",
    since: int = 0,
    after_id: int = 0,
    before_id: int = 0,
    limit: int = 50,
):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    if after_id and not since:
        since = after_id

    conn = get_db()
    cursor = conn.cursor()

    if not _is_member(cursor, conv_id, viewer):
        conn.close()
        return {"error": "not a member"}

    page_limit = max(1, min(limit, 200))
    fetch_limit = page_limit + 1

    base_where = """
        WHERE m.conversation_id = %s
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM chat_message_hidden h
              WHERE h.message_id = m.id
                AND h.user_name = %s
          )
    """

    if before_id > 0:
        sql = f"""
            SELECT m.id
            FROM chat_messages m
            {base_where}
              AND m.id < %s
            ORDER BY m.id DESC
            LIMIT %s
        """
        params = (conv_id, viewer, before_id, fetch_limit)
        cursor.execute(sql, params)
        ids = [r["id"] for r in cursor.fetchall()]

        has_more_older = len(ids) > page_limit
        ids = ids[:page_limit]
        ids.reverse()

        has_more_newer = False
    elif since > 0:
        sql = f"""
            SELECT m.id
            FROM chat_messages m
            {base_where}
              AND m.id > %s
            ORDER BY m.id ASC
            LIMIT %s
        """
        params = (conv_id, viewer, since, fetch_limit)
        cursor.execute(sql, params)
        ids = [r["id"] for r in cursor.fetchall()]

        has_more_newer = len(ids) > page_limit
        ids = ids[:page_limit]

        has_more_older = False
    else:
        sql = f"""
            SELECT m.id
            FROM chat_messages m
            {base_where}
            ORDER BY m.id DESC
            LIMIT %s
        """
        params = (conv_id, viewer, fetch_limit)
        cursor.execute(sql, params)
        ids = [r["id"] for r in cursor.fetchall()]

        has_more_older = len(ids) > page_limit
        ids = ids[:page_limit]
        ids.reverse()

        has_more_newer = False

    messages = _message_rows(cursor, ids, viewer)
    read_cursors, delivered_cursors = _cursors_for_conv(cursor, conv_id)
    conn.close()

    return {
        "messages": messages,
        "read_cursors": read_cursors,
        "delivered_cursors": delivered_cursors,
        "has_more_older": has_more_older,
        "has_more_newer": has_more_newer,
    }


# ---------------------------------------------------------------------------
# REST: send fallback when websocket is not open
# ---------------------------------------------------------------------------
@router.post("/chat/conversations/{conv_id}/messages")
async def send_rest(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    kind = data.get("kind", "text")
    body = (data.get("body") or "").strip()

    if not viewer_raw or kind not in USER_KINDS or not body:
        return {"error": "invalid message"}

    try:
        reply_to_id = _optional_int(data.get("reply_to_id"))
        forwarded_from_id = _optional_int(data.get("forwarded_from_id"))
    except Exception:
        return {"error": "invalid message id"}

    meta = data.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {}

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

        if _is_blocked_direct(cursor, conv_id, viewer):
            conn.rollback()
            return {"error": "this chat is blocked"}

        msg_id = _insert_message(
            cursor=cursor,
            conv_id=conv_id,
            sender=viewer,
            kind=kind,
            body=body,
            reply_to_id=reply_to_id,
            forwarded_from_id=forwarded_from_id,
            meta=meta,
        )

        row = _message_row(cursor, msg_id, viewer)
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    if row is None:
        return {"error": "message not found after insert"}

    await _broadcast_message(row, conv_id, viewer, sender_ws=None)

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
            """
            INSERT INTO chat_reads (conversation_id, user_name, last_read_id, last_delivered_id, updated_at)
            VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (conversation_id, user_name)
            DO UPDATE SET
                last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id),
                last_delivered_id = GREATEST(chat_reads.last_delivered_id, EXCLUDED.last_read_id),
                updated_at = CURRENT_TIMESTAMP
            """,
            (conv_id, viewer, last_id, last_id),
        )

        _touch_conversation_open(cursor, conv_id, viewer)
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
        }, default=str),
    )

    return {"message": "read"}