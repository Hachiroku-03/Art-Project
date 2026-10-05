import json
import threading

from fastapi import APIRouter

from db import get_db as _raw_get_db

router = APIRouter()

ALLOWED_CATEGORIES = {
    "messages",
    "mentions",
    "groups",
    "posts",
    "auctions",
    "calls",
    "wallet",
    "security",
    "system",
}

_schema_lock = threading.Lock()
_schema_ready = False


def _ensure_notifications_schema():
    """
    Lazy, idempotent schema creation.

    This must NOT run at import time. If Neon is temporarily unreachable,
    the app can still boot; the first request that needs notifications will
    retry schema creation.
    """
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        conn = _raw_get_db()
        try:
            cursor = conn.cursor()

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS notifications (
                  id SERIAL PRIMARY KEY,
                  user_name TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                  category TEXT NOT NULL,
                  type TEXT NOT NULL,
                  actor TEXT REFERENCES users(username),
                  source_type TEXT,
                  source_id INTEGER,
                  secondary_id INTEGER,
                  title TEXT NOT NULL,
                  body TEXT,
                  data JSONB NOT NULL DEFAULT '{}'::jsonb,
                  read_at TIMESTAMPTZ,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notifications_user_created "
                "ON notifications(user_name, created_at DESC)"
            )

            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread "
                "ON notifications(user_name, read_at, created_at DESC)"
            )

            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notifications_source "
                "ON notifications(source_type, source_id)"
            )

            conn.commit()
            _schema_ready = True
        finally:
            conn.close()


def get_db():
    """
    Local wrapper used by this router only.

    Every endpoint in this file calls get_db(). This ensures the notifications
    table exists before the first query, but only when a request actually
    arrives — not when Python imports the module.
    """
    _ensure_notifications_schema()
    return _raw_get_db()


def _canonical_username(cursor, name: str):
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


def _serialize(row):
    if row is None:
        return None

    out = dict(row)

    for key in ("created_at", "read_at"):
        value = out.get(key)
        if value is not None and hasattr(value, "isoformat"):
            out[key] = value.isoformat()

    data = out.get("data")

    if isinstance(data, str):
        try:
            out["data"] = json.loads(data)
        except Exception:
            out["data"] = {}
    elif data is None:
        out["data"] = {}

    return out


_SELECT_COLUMNS = """
    n.id,
    n.category,
    n.type,
    n.actor,
    COALESCE(p.display_name, u.username, n.actor) AS actor_display,
    p.avatar_url AS actor_avatar,
    n.source_type,
    n.source_id,
    n.secondary_id,
    n.title,
    n.body,
    n.data,
    n.read_at,
    n.created_at
"""

_FROM_JOINS = """
    FROM notifications n
    LEFT JOIN users u ON u.username = n.actor
    LEFT JOIN profiles p ON p.user_id = u.id
"""


@router.get("/notifications")
def list_notifications(
    viewer: str = "",
    category: str = "all",
    unread_only: bool = False,
    limit: int = 40,
    before_id: int = 0,
):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(limit, 100))

    if category == "unread":
        unread_only = True
        category = "all"

    if category != "all" and category not in ALLOWED_CATEGORIES:
        return {"error": "invalid category"}

    conn = get_db()
    cursor = conn.cursor()

    where = ["n.user_name = %s"]
    params = [viewer]

    if category != "all":
        where.append("n.category = %s")
        params.append(category)

    if unread_only:
        where.append("n.read_at IS NULL")

    if before_id > 0:
        where.append("n.id < %s")
        params.append(before_id)

    where_sql = " AND ".join(where)

    cursor.execute(
        f"""
        SELECT {_SELECT_COLUMNS}
        {_FROM_JOINS}
        WHERE {where_sql}
        ORDER BY n.id DESC
        LIMIT %s
        """,
        (*params, limit),
    )

    rows = [_serialize(r) for r in cursor.fetchall()]
    conn.close()

    return {
        "notifications": rows,
        "has_more": len(rows) == limit,
    }


@router.get("/notifications/since")
def notifications_since(viewer: str = "", after_id: int = 0, limit: int = 20):
    """
    Returns notifications with id > after_id, oldest-first, for live toasts.
    Cap limit low: this is a stream cursor, not a history endpoint.
    """
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    after_id = max(0, int(after_id or 0))
    limit = max(1, min(int(limit or 20), 50))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        f"""
        SELECT {_SELECT_COLUMNS}
        {_FROM_JOINS}
        WHERE n.user_name = %s
          AND n.id > %s
        ORDER BY n.id ASC
        LIMIT %s
        """,
        (viewer, after_id, limit),
    )

    rows = [_serialize(r) for r in cursor.fetchall()]
    conn.close()

    return {"notifications": rows}


@router.get("/notifications/unread-count")
def unread_count(viewer: str = ""):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE user_name = %s
          AND read_at IS NULL
        """,
        (viewer,),
    )

    row = cursor.fetchone()
    conn.close()

    return {"count": int((row or {}).get("count") or 0)}


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int, data: dict):
    viewer = _resolve_viewer(data.get("viewer") or "")
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            UPDATE notifications
            SET read_at = CURRENT_TIMESTAMP
            WHERE id = %s
              AND user_name = %s
              AND read_at IS NULL
            """,
            (notification_id, viewer),
        )

        conn.commit()
        return {"message": "notification marked read"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/notifications/read-all")
def mark_all_notifications_read(data: dict):
    viewer = _resolve_viewer(data.get("viewer") or "")
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            UPDATE notifications
            SET read_at = CURRENT_TIMESTAMP
            WHERE user_name = %s
              AND read_at IS NULL
            """,
            (viewer,),
        )

        conn.commit()
        return {"message": "all notifications marked read"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/notifications/{notification_id}/delete")
def delete_notification(notification_id: int, data: dict):
    viewer = _resolve_viewer(data.get("viewer") or "")
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            DELETE FROM notifications
            WHERE id = %s
              AND user_name = %s
            """,
            (notification_id, viewer),
        )

        conn.commit()
        return {"message": "notification deleted"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()