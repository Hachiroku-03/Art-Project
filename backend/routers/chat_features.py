import json

from fastapi import APIRouter

from db import get_db
from routers.chat import (
    manager,
    _canonical_username,
    _insert_message,
    _is_blocked_direct,
    _is_member,
    _member_names_from_id,
    _message_row,
    _message_rows,
    _resolve_viewer,
    _iso,
    _localize,
)

router = APIRouter()

REACTION_MAX_LEN = 16
MEDIA_KINDS = {"image", "video", "voice", "file"}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _dumps(obj) -> str:
    return json.dumps(obj, default=str)


def _public_message(row):
    """
    Strip viewer-private state before broadcasting a message to other members.
    Reactions include viewer_reacted for the requesting user; that must not leak.
    """
    if not row:
        return None

    r = dict(row)
    r["starred_by_viewer"] = False

    if isinstance(r.get("reactions"), list):
        r["reactions"] = [
            {**x, "viewer_reacted": False}
            for x in r["reactions"]
        ]

    return r


async def _broadcast_frame(conv_id: int, frame: dict, exclude_ws=None):
    members = _member_names_from_id(conv_id)
    await manager.send_to_users(members, _dumps(frame), exclude=exclude_ws)


def _role(cursor, conv_id: int, user: str):
    cursor.execute(
        "SELECT role FROM chat_members WHERE conversation_id = %s AND user_name = %s",
        (conv_id, user),
    )
    row = cursor.fetchone()
    return row["role"] if row else None


def _conversation_kind(cursor, conv_id: int):
    cursor.execute(
        "SELECT kind FROM chat_conversations WHERE id = %s",
        (conv_id,),
    )
    row = cursor.fetchone()
    return row["kind"] if row else None


def _can_manage_group(cursor, conv_id: int, user: str) -> bool:
    return _role(cursor, conv_id, user) in {"owner", "admin"}


def _validate_emoji(emoji: str):
    emoji = (emoji or "").strip()
    if not emoji or len(emoji) > REACTION_MAX_LEN:
        return None
    return emoji


def _parse_meta(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


# ---------------------------------------------------------------------------
# message lifecycle: edit / delete / hide
# ---------------------------------------------------------------------------
@router.patch("/chat/messages/{message_id}")
async def edit_message(message_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    body = (data.get("body") or "").strip()

    if not viewer:
        return {"error": "viewer required"}
    if not body:
        return {"error": "body required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            SELECT conversation_id, sender, kind, deleted_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg or msg["deleted_at"]:
            raise ValueError("message not found")

        if not _is_member(cursor, msg["conversation_id"], viewer):
            raise ValueError("not a member")

        if msg["sender"] != viewer:
            raise ValueError("only the sender can edit this message")

        if msg["kind"] != "text":
            raise ValueError("only text messages can be edited")

        cursor.execute(
            """
            UPDATE chat_messages
            SET body = %s,
                edited_at = CURRENT_TIMESTAMP
            WHERE id = %s
              AND deleted_at IS NULL
            """,
            (body, message_id),
        )

        row = _message_row(cursor, message_id, viewer)
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    if row:
        await _broadcast_frame(
            row["conversation_id"],
            {
                "type": "message_edited",
                "message": _public_message(row),
            },
        )

    return {"message": row}


@router.delete("/chat/messages/{message_id}")
async def delete_message_for_everyone(message_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            SELECT conversation_id, sender, deleted_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg:
            raise ValueError("message not found")

        conv_id = msg["conversation_id"]

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        allowed = msg["sender"] == viewer

        if not allowed and _conversation_kind(cursor, conv_id) == "group":
            allowed = _can_manage_group(cursor, conv_id, viewer)

        if not allowed:
            raise ValueError("not allowed to delete this message")

        if not msg["deleted_at"]:
            cursor.execute(
                """
                UPDATE chat_messages
                SET deleted_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (message_id,),
            )

        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    await _broadcast_frame(
        conv_id,
        {
            "type": "message_deleted",
            "conversation_id": conv_id,
            "message_id": message_id,
        },
    )

    return {"message": "deleted"}


@router.post("/chat/messages/{message_id}/hide")
def hide_message_for_me(message_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            "SELECT conversation_id FROM chat_messages WHERE id = %s",
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg:
            raise ValueError("message not found")

        if not _is_member(cursor, msg["conversation_id"], viewer):
            raise ValueError("not a member")

        cursor.execute(
            """
            INSERT INTO chat_message_hidden (message_id, user_name)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
            """,
            (message_id, viewer),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "hidden"}


# ---------------------------------------------------------------------------
# reactions
# ---------------------------------------------------------------------------
@router.post("/chat/messages/{message_id}/react")
async def react_to_message(message_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    emoji = _validate_emoji(data.get("emoji") or "")

    if not viewer:
        return {"error": "viewer required"}
    if not emoji:
        return {"error": "valid emoji required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            SELECT conversation_id, deleted_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg or msg["deleted_at"]:
            raise ValueError("message not found")

        conv_id = msg["conversation_id"]

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        cursor.execute(
            """
            INSERT INTO chat_reactions (message_id, user_name, emoji)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (message_id, viewer, emoji),
        )

        row = _message_row(cursor, message_id, viewer)
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    await _broadcast_frame(
        conv_id,
        {
            "type": "reaction_added",
            "conversation_id": conv_id,
            "message_id": message_id,
            "user_name": viewer,
            "emoji": emoji,
        },
    )

    return {"message": row}


@router.delete("/chat/messages/{message_id}/react")
async def unreact_to_message(message_id: int, viewer: str = "", emoji: str = ""):
    viewer = _resolve_viewer(viewer)
    emoji = _validate_emoji(emoji)

    if not viewer:
        return {"error": "viewer required"}
    if not emoji:
        return {"error": "valid emoji required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            SELECT conversation_id, deleted_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg or msg["deleted_at"]:
            raise ValueError("message not found")

        conv_id = msg["conversation_id"]

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        cursor.execute(
            """
            DELETE FROM chat_reactions
            WHERE message_id = %s
              AND user_name = %s
              AND emoji = %s
            """,
            (message_id, viewer, emoji),
        )

        row = _message_row(cursor, message_id, viewer)
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    await _broadcast_frame(
        conv_id,
        {
            "type": "reaction_removed",
            "conversation_id": conv_id,
            "message_id": message_id,
            "user_name": viewer,
            "emoji": emoji,
        },
    )

    return {"message": row}


# ---------------------------------------------------------------------------
# star / save
# ---------------------------------------------------------------------------
@router.post("/chat/messages/{message_id}/star")
def star_message(message_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            "SELECT conversation_id FROM chat_messages WHERE id = %s",
            (message_id,),
        )
        msg = cursor.fetchone()

        if not msg:
            raise ValueError("message not found")

        if not _is_member(cursor, msg["conversation_id"], viewer):
            raise ValueError("not a member")

        cursor.execute(
            """
            INSERT INTO chat_starred_messages (message_id, user_name)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
            """,
            (message_id, viewer),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"starred": True}


@router.delete("/chat/messages/{message_id}/star")
def unstar_message(message_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            DELETE FROM chat_starred_messages
            WHERE message_id = %s
              AND user_name = %s
            """,
            (message_id, viewer),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"starred": False}


# ---------------------------------------------------------------------------
# forward
# ---------------------------------------------------------------------------
@router.post("/chat/messages/{message_id}/forward")
async def forward_message(message_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    target_ids = data.get("to_conversation_ids") or []

    if not viewer:
        return {"error": "viewer required"}

    if not isinstance(target_ids, list) or not target_ids:
        return {"error": "to_conversation_ids required"}

    conn = get_db()
    cursor = conn.cursor()
    created = []

    try:
        cursor.execute(
            """
            SELECT conversation_id, kind, body, meta, deleted_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )
        source = cursor.fetchone()

        if not source or source["deleted_at"]:
            raise ValueError("message not found")

        if not _is_member(cursor, source["conversation_id"], viewer):
            raise ValueError("not a member")

        meta = _parse_meta(source.get("meta"))

        for raw_target in target_ids:
            try:
                target_conv_id = int(raw_target)
            except Exception:
                continue

            if not _is_member(cursor, target_conv_id, viewer):
                raise ValueError(f"not a member of conversation {target_conv_id}")

            if _conversation_kind(cursor, target_conv_id) == "direct" and _is_blocked_direct(cursor, target_conv_id, viewer):
                raise ValueError(f"conversation {target_conv_id} is blocked")

            new_meta = dict(meta)
            new_meta["forwarded"] = True

            new_id = _insert_message(
                cursor=cursor,
                conv_id=target_conv_id,
                sender=viewer,
                kind=source["kind"],
                body=source["body"],
                reply_to_id=None,
                forwarded_from_id=message_id,
                meta=new_meta,
            )

            row = _message_row(cursor, new_id, viewer)
            if row:
                created.append(row)

        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    for row in created:
        await _broadcast_frame(
            row["conversation_id"],
            {
                "type": "message",
                "message": _public_message(row),
            },
        )

    return {"messages": created}


# ---------------------------------------------------------------------------
# drafts
# ---------------------------------------------------------------------------
@router.get("/chat/drafts")
def get_drafts(viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT conversation_id, body, updated_at::text AS updated_at
        FROM chat_drafts
        WHERE user_name = %s
        """,
        (viewer,),
    )

    rows = [dict(r) for r in cursor.fetchall()]

    for r in rows:
        _localize(r, "updated_at")

    conn.close()

    return {"drafts": rows}


@router.put("/chat/drafts")
def save_draft(data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    conv_id = data.get("conversation_id")
    body = (data.get("body") or "")

    if not viewer:
        return {"error": "viewer required"}

    if conv_id is None:
        return {"error": "conversation_id required"}

    try:
        conv_id = int(conv_id)
    except Exception:
        return {"error": "invalid conversation_id"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        clean = body.strip()

        if not clean:
            cursor.execute(
                """
                DELETE FROM chat_drafts
                WHERE conversation_id = %s
                  AND user_name = %s
                """,
                (conv_id, viewer),
            )
            conn.commit()
            return {"draft": None}

        cursor.execute(
            """
            INSERT INTO chat_drafts (conversation_id, user_name, body, updated_at)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (conversation_id, user_name)
            DO UPDATE SET
                body = EXCLUDED.body,
                updated_at = CURRENT_TIMESTAMP
            """,
            (conv_id, viewer, clean),
        )

        cursor.execute(
            """
            SELECT conversation_id, body, updated_at::text AS updated_at
            FROM chat_drafts
            WHERE conversation_id = %s
              AND user_name = %s
            """,
            (conv_id, viewer),
        )
        if row:
            row = dict(row)
            _localize(row, "updated_at")
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"draft": row if row else None}


@router.delete("/chat/drafts/{conversation_id}")
def delete_draft(conversation_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        if not _is_member(cursor, conversation_id, viewer):
            raise ValueError("not a member")

        cursor.execute(
            """
            DELETE FROM chat_drafts
            WHERE conversation_id = %s
              AND user_name = %s
            """,
            (conversation_id, viewer),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "draft deleted"}


# ---------------------------------------------------------------------------
# conversation prefs: archive / mute / pin / mark unread
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/prefs")
def get_conversation_prefs(conv_id: int, viewer: str = ""):
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
        SELECT
            conversation_id,
            user_name,
            archived,
            muted,
            pinned,
            pinned_at::text AS pinned_at,
            muted_until::text AS muted_until,
            last_opened_at::text AS last_opened_at,
            mark_unread,
            updated_at::text AS updated_at
        FROM chat_conversation_prefs
        WHERE conversation_id = %s
          AND user_name = %s
        """,
        (conv_id, viewer),
    )

    row = cursor.fetchone()
    conn.close()

    if row:
        row = dict(row)
        _localize(row, "pinned_at", "muted_until", "last_opened_at", "updated_at")

    if not row:
        return {
            "prefs": {
                "conversation_id": conv_id,
                "user_name": viewer,
                "archived": False,
                "muted": False,
                "pinned": False,
                "pinned_at": None,
                "muted_until": None,
                "last_opened_at": None,
                "mark_unread": False,
                "updated_at": None,
            }
        }

    return {"prefs": dict(row)}


@router.put("/chat/conversations/{conv_id}/prefs")
def update_conversation_prefs(conv_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    archived = data.get("archived")
    muted = data.get("muted")
    pinned = data.get("pinned")
    muted_until = data.get("muted_until")
    mark_unread = data.get("mark_unread")

    conn = get_db()
    cursor = conn.cursor()

    try:
        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

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
            VALUES (
                %s,
                %s,
                COALESCE(%s::boolean, FALSE),
                COALESCE(%s::boolean, FALSE),
                COALESCE(%s::boolean, FALSE),
                CASE WHEN COALESCE(%s::boolean, FALSE) THEN CURRENT_TIMESTAMP ELSE NULL END,
                %s::timestamp,
                CURRENT_TIMESTAMP,
                COALESCE(%s::boolean, FALSE),
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (conversation_id, user_name)
            DO UPDATE SET
                archived = COALESCE(%s::boolean, chat_conversation_prefs.archived),
                muted = COALESCE(%s::boolean, chat_conversation_prefs.muted),
                pinned = COALESCE(%s::boolean, chat_conversation_prefs.pinned),
                pinned_at = CASE
                    WHEN COALESCE(%s::boolean, chat_conversation_prefs.pinned)
                    THEN COALESCE(chat_conversation_prefs.pinned_at, CURRENT_TIMESTAMP)
                    ELSE NULL
                END,
                muted_until = COALESCE(%s::timestamp, chat_conversation_prefs.muted_until),
                mark_unread = COALESCE(%s::boolean, chat_conversation_prefs.mark_unread),
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                conv_id,
                viewer,
                archived,
                muted,
                pinned,
                pinned,
                muted_until,
                mark_unread,
                archived,
                muted,
                pinned,
                pinned,
                muted_until,
                mark_unread,
            ),
        )

        cursor.execute(
            """
            SELECT
                conversation_id,
                user_name,
                archived,
                muted,
                pinned,
                pinned_at::text AS pinned_at,
                muted_until::text AS muted_until,
                last_opened_at::text AS last_opened_at,
                mark_unread,
                updated_at::text AS updated_at
            FROM chat_conversation_prefs
            WHERE conversation_id = %s
              AND user_name = %s
            """,
            (conv_id, viewer),
        )

        row = cursor.fetchone()
        conn.commit()

        if row:
            row = dict(row)
            _localize(row, "pinned_at", "muted_until", "last_opened_at", "updated_at")
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"prefs": dict(row) if row else None}


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------
@router.get("/chat/search")
def search_messages(viewer: str = "", q: str = "", conversation_id: int = 0, limit: int = 50):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}
    query = (q or "").strip()
    if not query:
        return {"messages": []}
    limit = max(1, min(limit, 100))
    pattern = f"%{query}%"
    conn = get_db(); cursor = conn.cursor()
    cursor.execute(
        """
        SELECT m.id
        FROM chat_messages m
        WHERE m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id=m.id AND h.user_name=%s)
          AND m.conversation_id IN (SELECT conversation_id FROM chat_members WHERE user_name=%s)
          AND (%s::int = 0 OR m.conversation_id = %s)
          AND m.body ILIKE %s
        ORDER BY m.id DESC
        LIMIT %s
        """,
        (viewer, viewer, conversation_id, conversation_id, pattern, limit),
    )
    ids = [r["id"] for r in cursor.fetchall()]
    messages = _message_rows(cursor, ids, viewer)   # full + localized rows
    messages.reverse()                              # newest-first for results
    conn.close()
    return {"messages": messages}


@router.get("/chat/conversations/{conv_id}/media")
def conversation_media(conv_id: int, viewer: str = "", kind: str = "all", before_id: int = 0, limit: int = 50):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}
    kind = (kind or "all").strip().lower()
    if kind != "all" and kind not in MEDIA_KINDS:
        return {"error": "kind must be all, image, video, voice, or file"}
    limit = max(1, min(limit, 100)); fetch_limit = limit + 1
    conn = get_db(); cursor = conn.cursor()
    if not _is_member(cursor, conv_id, viewer):
        conn.close(); return {"error": "not a member"}
    base_where = """
        WHERE m.conversation_id = %s
          AND m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id=m.id AND h.user_name=%s)
    """
    params = [conv_id, viewer]
    if kind == "all":
        base_where += " AND m.kind = ANY(%s)"; params.append(list(MEDIA_KINDS))
    else:
        base_where += " AND m.kind = %s"; params.append(kind)
    if before_id > 0:
        base_where += " AND m.id < %s"; params.append(before_id)
    params.append(fetch_limit)
    cursor.execute(f"SELECT m.id FROM chat_messages m {base_where} ORDER BY m.id DESC LIMIT %s", tuple(params))
    rows = cursor.fetchall()
    ids = [r["id"] for r in rows]
    has_more = len(ids) > limit
    ids = ids[:limit]
    messages = _message_rows(cursor, ids, viewer)   # full + localized rows
    messages.reverse()                              # newest-first grid
    conn.close()
    return {"messages": messages, "has_more": has_more}


# ---------------------------------------------------------------------------
# media gallery
# ---------------------------------------------------------------------------
@router.get("/chat/conversations/{conv_id}/media")
def conversation_media(
    conv_id: int,
    viewer: str = "",
    kind: str = "all",
    before_id: int = 0,
    limit: int = 50,
):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    kind = (kind or "all").strip().lower()

    if kind != "all" and kind not in MEDIA_KINDS:
        return {"error": "kind must be all, image, video, voice, or file"}

    limit = max(1, min(limit, 100))
    fetch_limit = limit + 1

    conn = get_db()
    cursor = conn.cursor()

    if not _is_member(cursor, conv_id, viewer):
        conn.close()
        return {"error": "not a member"}

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

    params = [conv_id, viewer]

    if kind == "all":
        base_where += " AND m.kind = ANY(%s)"
        params.append(list(MEDIA_KINDS))
    else:
        base_where += " AND m.kind = %s"
        params.append(kind)

    if before_id > 0:
        base_where += " AND m.id < %s"
        params.append(before_id)

    params.append(fetch_limit)

    sql = f"""
        SELECT m.id
        FROM chat_messages m
        {base_where}
        ORDER BY m.id DESC
        LIMIT %s
    """

    cursor.execute(sql, tuple(params))
    rows = cursor.fetchall()

    ids = [r["id"] for r in rows]
    has_more = len(ids) > limit
    ids = ids[:limit]

    messages = _message_rows(cursor, ids, viewer)

    # Media gallery should be newest-first.
    messages.reverse()

    conn.close()

    return {
        "messages": messages,
        "has_more": has_more,
    }


# ---------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------
@router.post("/chat/blocks")
def block_user(data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    blocked_raw = (data.get("blocked") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        blocked = _canonical_username(cursor, blocked_raw)

        if not blocked:
            raise ValueError("unknown user")

        if blocked == viewer:
            raise ValueError("you cannot block yourself")

        cursor.execute(
            """
            INSERT INTO chat_blocks (blocker, blocked)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
            """,
            (viewer, blocked),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "blocked"}


@router.delete("/chat/blocks/{blocked}")
def unblock_user(blocked: str, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            DELETE FROM chat_blocks
            WHERE blocker = %s
              AND lower(blocked) = lower(%s)
            """,
            (viewer, blocked),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "unblocked"}


@router.get("/chat/blocks")
def list_blocks(viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT blocked, created_at::text AS created_at
        FROM chat_blocks
        WHERE blocker = %s
        ORDER BY created_at DESC
        """,
        (viewer,),
    )

    rows = [dict(r) for r in cursor.fetchall()]

    for r in rows:
        _localize(r, "created_at")

    conn.close()

    return {"blocks": rows}


# ---------------------------------------------------------------------------
# reports
# ---------------------------------------------------------------------------
@router.post("/chat/reports")
def report_content(data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())
    target_type = (data.get("target_type") or "").strip().lower()
    target_id = data.get("target_id")
    target_text = (data.get("target_text") or "").strip()
    reason = (data.get("reason") or "").strip()
    details = (data.get("details") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    if target_type not in {"message", "conversation", "user"}:
        return {"error": "target_type must be message, conversation, or user"}

    if not reason:
        return {"error": "reason required"}

    if target_type == "user" and not target_text:
        return {"error": "target_text required for user reports"}

    if target_type in {"message", "conversation"} and not target_id:
        return {"error": "target_id required for message/conversation reports"}

    try:
        target_id = int(target_id) if target_id is not None else None
    except Exception:
        return {"error": "invalid target_id"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        if target_type == "user":
            resolved = _canonical_username(cursor, target_text)
            target_text = resolved or target_text

        cursor.execute(
            """
            INSERT INTO chat_reports (
                reporter,
                target_type,
                target_id,
                target_text,
                reason,
                details
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (viewer, target_type, target_id, target_text, reason, details),
        )

        report_id = cursor.fetchone()["id"]
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"report_id": report_id}


# ---------------------------------------------------------------------------
# notifications
# ---------------------------------------------------------------------------
@router.get("/chat/notifications")
def list_notifications(
    viewer: str = "",
    unread_only: bool = False,
    limit: int = 50,
):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(limit, 100))

    conn = get_db()
    cursor = conn.cursor()

    sql = """
        SELECT
            id,
            conversation_id,
            message_id,
            type,
            title,
            body,
            created_at::text AS created_at,
            read_at::text AS read_at
        FROM chat_notifications
        WHERE user_name = %s
    """

    params = [viewer]

    if unread_only:
        sql += " AND read_at IS NULL"

    sql += " ORDER BY created_at DESC LIMIT %s"
    params.append(limit)

    cursor.execute(sql, tuple(params))
    rows = [dict(r) for r in cursor.fetchall()]

    for r in rows:
        _localize(r, "created_at", "read_at")

    conn.close()

    return {"notifications": rows}


@router.post("/chat/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            UPDATE chat_notifications
            SET read_at = CURRENT_TIMESTAMP
            WHERE id = %s
              AND user_name = %s
              AND read_at IS NULL
            """,
            (notification_id, viewer),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "read"}


@router.post("/chat/notifications/read-all")
def mark_all_notifications_read(data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            UPDATE chat_notifications
            SET read_at = CURRENT_TIMESTAMP
            WHERE user_name = %s
              AND read_at IS NULL
            """,
            (viewer,),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "all read"}


@router.get("/chat/unread-total")
def unread_total(viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT COUNT(*) AS c
        FROM chat_messages m
        JOIN chat_members cm
          ON cm.conversation_id = m.conversation_id
         AND cm.user_name = %s
        LEFT JOIN chat_conversation_prefs p
          ON p.conversation_id = m.conversation_id
         AND p.user_name = %s
        WHERE m.sender <> %s
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM chat_message_hidden h
              WHERE h.message_id = m.id
                AND h.user_name = %s
          )
          AND COALESCE(p.archived, FALSE) = FALSE
          AND (
              COALESCE(p.mark_unread, FALSE)
              OR m.id > COALESCE(
                  (
                      SELECT r.last_read_id
                      FROM chat_reads r
                      WHERE r.conversation_id = m.conversation_id
                        AND r.user_name = %s
                  ),
                  0
              )
          )
        """,
        (viewer, viewer, viewer, viewer, viewer),
    )

    messages = cursor.fetchone()["c"]

    cursor.execute(
        """
        SELECT COUNT(*) AS c
        FROM chat_notifications
        WHERE user_name = %s
          AND read_at IS NULL
        """,
        (viewer,),
    )

    notifications = cursor.fetchone()["c"]
    conn.close()

    return {
        "messages": messages,
        "notifications": notifications,
        "total": messages + notifications,
    }


# ---------------------------------------------------------------------------
# presence
# ---------------------------------------------------------------------------
@router.get("/chat/presence")
def get_presence(viewer: str = "", users: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    usernames = [u.strip() for u in (users or "").split(",") if u.strip()]
    usernames = list(dict.fromkeys(usernames))[:50]

    if not usernames:
        return {"presence": []}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT
            pr.user_name,
            pr.online,
            pr.last_seen_at::text AS last_seen_at
        FROM chat_presence pr
        WHERE pr.user_name = ANY(%s)
          AND EXISTS (
              SELECT 1
              FROM chat_members a
              JOIN chat_members b ON b.conversation_id = a.conversation_id
              WHERE a.user_name = %s
                AND b.user_name = pr.user_name
          )
        """,
        (usernames, viewer),
    )

    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    return {"presence": rows}


# ---------------------------------------------------------------------------
# group management
# ---------------------------------------------------------------------------
@router.patch("/chat/conversations/{conv_id}")
async def update_conversation(conv_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("only groups can be updated")

        if not _can_manage_group(cursor, conv_id, viewer):
            raise ValueError("only owners/admins can update this group")

        sets = []
        params = []

        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                raise ValueError("group name cannot be empty")
            sets.append("name = %s")
            params.append(name)

        if "description" in data:
            description = (data.get("description") or "").strip() or None
            sets.append("description = %s")
            params.append(description)

        if "image_url" in data:
            image_url = (data.get("image_url") or "").strip() or None
            sets.append("image_url = %s")
            params.append(image_url)

        if not sets:
            raise ValueError("no fields to update")

        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.append(conv_id)

        cursor.execute(
            f"""
            UPDATE chat_conversations
            SET {", ".join(sets)}
            WHERE id = %s
            """,
            tuple(params),
        )

        cursor.execute(
            """
            SELECT
                id,
                kind,
                name,
                image_url,
                description,
                updated_at::text AS updated_at
            FROM chat_conversations
            WHERE id = %s
            """,
            (conv_id,),
        )

        row = cursor.fetchone()
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    conversation = dict(row) if row else None

    if conversation:
       _localize(conversation, "updated_at")
    
    if conversation:
        await _broadcast_frame(
            conv_id,
            {
                "type": "conversation_updated",
                "conversation": conversation,
            },
        )

    return {"conversation": conversation}


@router.post("/chat/conversations/{conv_id}/leave")
async def leave_conversation(conv_id: int, data: dict):
    viewer = _resolve_viewer((data.get("viewer") or "").strip())

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    conversation_still_exists = True

    try:
        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("leave is only supported for group chats")

        role = _role(cursor, conv_id, viewer)

        cursor.execute(
            """
            SELECT user_name
            FROM chat_members
            WHERE conversation_id = %s
              AND user_name <> %s
            ORDER BY joined_at ASC
            LIMIT 1
            """,
            (conv_id, viewer),
        )
        successor = cursor.fetchone()

        if role == "owner":
            if successor:
                cursor.execute(
                    """
                    UPDATE chat_members
                    SET role = 'owner'
                    WHERE conversation_id = %s
                      AND user_name = %s
                    """,
                    (conv_id, successor["user_name"]),
                )
                cursor.execute(
                    """
                    DELETE FROM chat_members
                    WHERE conversation_id = %s
                      AND user_name = %s
                    """,
                    (conv_id, viewer),
                )
            else:
                cursor.execute(
                    "DELETE FROM chat_conversations WHERE id = %s",
                    (conv_id,),
                )
                conversation_still_exists = False
        else:
            cursor.execute(
                """
                DELETE FROM chat_members
                WHERE conversation_id = %s
                  AND user_name = %s
                """,
                (conv_id, viewer),
            )

        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    if conversation_still_exists:
        await _broadcast_frame(
            conv_id,
            {
                "type": "member_removed",
                "conversation_id": conv_id,
                "user_name": viewer,
            },
        )

    return {"message": "left"}


@router.delete("/chat/conversations/{conv_id}")
async def delete_group(conv_id: int, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("only groups can be deleted")

        if _role(cursor, conv_id, viewer) != "owner":
            raise ValueError("only the owner can delete this group")

        cursor.execute(
            "DELETE FROM chat_conversations WHERE id = %s",
            (conv_id,),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "group deleted"}


@router.post("/chat/conversations/{conv_id}/members/{user_name}/remove")
async def remove_group_member(conv_id: int, user_name: str, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        target = _canonical_username(cursor, user_name)

        if not target:
            raise ValueError("unknown user")

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("only groups support member removal")

        if not _can_manage_group(cursor, conv_id, viewer):
            raise ValueError("only owners/admins can remove members")

        if target == viewer:
            raise ValueError("use leave endpoint to remove yourself")

        target_role = _role(cursor, conv_id, target)

        if target_role == "owner":
            raise ValueError("cannot remove the group owner")

        cursor.execute(
            """
            DELETE FROM chat_members
            WHERE conversation_id = %s
              AND user_name = %s
            """,
            (conv_id, target),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    await _broadcast_frame(
        conv_id,
        {
            "type": "member_removed",
            "conversation_id": conv_id,
            "user_name": target,
        },
    )

    return {"message": "member removed"}


@router.post("/chat/conversations/{conv_id}/members/{user_name}/promote")
def promote_group_member(conv_id: int, user_name: str, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        target = _canonical_username(cursor, user_name)

        if not target:
            raise ValueError("unknown user")

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("only groups support admin promotion")

        if _role(cursor, conv_id, viewer) != "owner":
            raise ValueError("only the owner can promote admins")

        if target == viewer:
            raise ValueError("you cannot promote yourself")

        cursor.execute(
            """
            UPDATE chat_members
            SET role = 'admin'
            WHERE conversation_id = %s
              AND user_name = %s
              AND role <> 'owner'
            """,
            (conv_id, target),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "member promoted"}


@router.post("/chat/conversations/{conv_id}/members/{user_name}/demote")
def demote_group_member(conv_id: int, user_name: str, viewer: str = ""):
    viewer = _resolve_viewer(viewer)

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        target = _canonical_username(cursor, user_name)

        if not target:
            raise ValueError("unknown user")

        if not _is_member(cursor, conv_id, viewer):
            raise ValueError("not a member")

        if _conversation_kind(cursor, conv_id) != "group":
            raise ValueError("only groups support admin demotion")

        if _role(cursor, conv_id, viewer) != "owner":
            raise ValueError("only the owner can demote admins")

        cursor.execute(
            """
            UPDATE chat_members
            SET role = 'member'
            WHERE conversation_id = %s
              AND user_name = %s
              AND role = 'admin'
            """,
            (conv_id, target),
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

    return {"message": "member demoted"}