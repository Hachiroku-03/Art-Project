"""
Chat router: WebSocket + REST.

UPDATED:
- Uses psycopg2 ThreadedConnectionPool.
- Adds ping/pong heartbeat handler for frontend reconnect detection.
- Adds db() context manager for safer transactions.
- Compatible with Neon pooled endpoint:
  does NOT pass unsupported startup options like statement_timeout.
- Adds /chat/health pool stats endpoint.
- Restores _resolve_viewer for chat_features.py compatibility.
- All existing business logic preserved.

NOTIFICATION HARDENING (this revision):
- _notify_chat_targets_sync now isolates EACH recipient behind a SAVEPOINT and
  logs every failure under 'chat.notify'. The previous bare
  `except Exception: pass` silently destroyed new notification rows whenever a
  recipient hit a mid-transaction Neon drop (query_wait_timeout /
  "SSL connection has been closed unexpectedly" / "Terminating connection due
  to administrator command"); that silent swallow is gone.
- Live-delivered, non-mentioned recipients are intentionally skipped (they
  already saw the message) and now logged at debug, so "old rows show, new rows
  don't" is explainable when both accounts are open in tabs.
- init_pool() retries through Neon scale-to-zero cold start ("Couldn't connect
  to compute node" / timeout expired) instead of failing the first request.
"""

import json
import asyncio
import re
from contextlib import contextmanager
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from psycopg2 import pool as pg_pool
from psycopg2 import errors as pg_errors
from psycopg2 import extensions as pg_extensions
from psycopg2.extras import RealDictCursor
import logging as _logging

import time
from psycopg2 import InterfaceError, OperationalError

import os
import psycopg2

from notification_service import create_notification

import datetime as _dt


# ---------------------------------------------------------------------------
# Timezone handling.
#
# Chat timestamps in this schema are plain TIMESTAMP values. For stability,
# serialize them as UTC. This removes the runtime dependency on the system/
# Python timezone database inside chat.py.
# ---------------------------------------------------------------------------

_TZ_CACHE = _dt.timezone.utc


def _db_tz():
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

USER_KINDS = MESSAGE_KINDS - {"system"}

_notify_log = _logging.getLogger("chat.notify")

# ---------------------------------------------------------------------------
# DB pool config.
# ---------------------------------------------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL missing — check your .env file")

CHAT_POOL_MIN = max(1, int(os.getenv("CHAT_DB_POOL_MIN", "1")))
CHAT_POOL_MAX = max(CHAT_POOL_MIN, int(os.getenv("CHAT_DB_POOL_MAX", "8")))
CHAT_DB_CONNECT_TIMEOUT = max(1, int(os.getenv("CHAT_DB_CONNECT_TIMEOUT", "8")))

# These are kept for health reporting only.
#
# IMPORTANT:
# Do NOT pass statement_timeout / idle_in_transaction_session_timeout
# through psycopg2 options when using the Neon pooled endpoint.
#
# Neon's PgBouncer rejects unsupported startup parameters:
#   unsupported startup parameter in options: statement_timeout
#
# If you need real PostgreSQL statement timeouts, use the direct/unpooled
# Neon endpoint instead of the -pooler endpoint.
CHAT_DB_STATEMENT_TIMEOUT_MS = max(
    0,
    int(os.getenv("CHAT_DB_STATEMENT_TIMEOUT_MS", "15000")),
)
CHAT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = max(
    0,
    int(os.getenv("CHAT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "30000")),
)

POOL: pg_pool.ThreadedConnectionPool | None = None


def init_pool():
    """
    Build the chat pool, retrying through Neon scale-to-zero cold start.

    After the compute suspends (>=5 min idle), the very first connect can fail
    with "timeout expired" — the documented "Couldn't connect to compute node"
    case, whose remedy is pause + reconnect. A single failed attempt used to
    leave POOL unset and make the first request (and the notify thread) fail;
    now we back off and retry, then fall back to lazy rebuild on the next call.
    """
    global POOL

    if POOL is not None:
        return

    # Cold start needs more headroom than the steady-state connect timeout.
    effective_timeout = max(CHAT_DB_CONNECT_TIMEOUT, 15)
    last_exc: Exception | None = None

    for attempt in range(4):
        try:
            POOL = pg_pool.ThreadedConnectionPool(
                CHAT_POOL_MIN,
                CHAT_POOL_MAX,
                DATABASE_URL,
                cursor_factory=RealDictCursor,
                connect_timeout=effective_timeout,
            )
            if attempt > 0:
                _notify_log.info("chat pool recovered on attempt %d", attempt + 1)
            return
        except Exception as exc:
            last_exc = exc
            POOL = None
            if attempt < 3:
                wait = 2 * (attempt + 1)
                _notify_log.warning(
                    "chat pool init failed (attempt %d/4): %r; retrying in %ds",
                    attempt + 1,
                    exc,
                    wait,
                )
                time.sleep(wait)

    # Still failing: leave POOL None. db() will retry lazily on the next call,
    # and the request that triggered this returns a clean error JSON rather
    # than crashing.
    _notify_log.error("chat pool init failed after retries: %r", last_exc)


_STALE_DB_MARKERS = (
    "ssl connection has been closed unexpectedly",
    "server closed the connection unexpectedly",
    "connection already closed",
    "terminated by administrator command",
    "could not receive data from server",
    "could not send data to server",
    "connection reset by peer",
    "unexpected EOF on client connection",
    "the connection is closed",
    "pq_getmessage: unexpected EOF",
)


def _is_stale_db_error(exc: Exception) -> bool:
    msg = str(exc).lower()

    if isinstance(exc, (InterfaceError, OperationalError)):
        return any(marker in msg for marker in _STALE_DB_MARKERS)

    return any(marker in msg for marker in _STALE_DB_MARKERS)


def _discard_pooled_conn(conn):
    if POOL is None or conn is None:
        return

    try:
        POOL.putconn(conn, close=True)
    except Exception:
        try:
            if not conn.closed:
                conn.close()
        except Exception:
            pass


@contextmanager
def db():
    """
    Get a pooled connection.

    This version tries to discard stale Neon/PgBouncer connections before use.
    If a connection dies during the request, it is discarded so the next
    request does not reuse the dead socket.
    """
    if POOL is None:
        init_pool()

    if POOL is None:
        # init_pool exhausted its retries (e.g. compute still waking). Surface
        # a clean error instead of an AttributeError on POOL.getconn().
        raise RuntimeError("chat database pool unavailable (cold start?)")

    conn = None
    last_error = None

    # Try up to 3 times to acquire a live connection.
    for attempt in range(3):
        try:
            conn = POOL.getconn()
        except pg_pool.PoolError as exc:
            raise RuntimeError("chat database connection pool exhausted") from exc

        # Pre-ping the connection.
        # This helps catch stale SSL connections before the real query runs.
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            cursor.fetchone()
            cursor.close()
            break
        except Exception as exc:
            last_error = exc
            _discard_pooled_conn(conn)
            conn = None

            if attempt == 2 or not _is_stale_db_error(exc):
                raise

            time.sleep(0.2 * (attempt + 1))

    try:
        yield conn
        conn.commit()
    except Exception as exc:
        try:
            if conn is not None and not conn.closed:
                conn.rollback()
        except Exception:
            pass

        # If the connection died mid-request, discard it.
        if _is_stale_db_error(exc):
            _discard_pooled_conn(conn)
            conn = None

        raise
    finally:
        try:
            if conn is not None and not conn.closed:
                if (
                    conn.info.transaction_status
                    != pg_extensions.TRANSACTION_STATUS_IDLE
                ):
                    conn.rollback()
        except Exception:
            pass

        if conn is not None:
            try:
                POOL.putconn(conn)
            except Exception:
                _discard_pooled_conn(conn)

# ---------------------------------------------------------------------------
# Compatibility re-export.
#
# Some older files may import get_db from routers.chat.
# Prefer db() internally, but keep get_db available if db.py exists.
# ---------------------------------------------------------------------------

try:
    from db import get_db  # noqa: F401
except Exception:
    def get_db():
        """
        Fallback direct connection for compatibility only.
        Internal chat code should prefer db().
        """
        return psycopg2.connect(
            DATABASE_URL,
            cursor_factory=RealDictCursor,
            connect_timeout=CHAT_DB_CONNECT_TIMEOUT,
        )


# ---------------------------------------------------------------------------
# Safe notification wrapper.
# ---------------------------------------------------------------------------

def _create_notification(**kwargs):
    try:
        return create_notification(**kwargs)
    except TypeError as exc:
        if "legacy_type" in str(exc):
            kwargs.pop("legacy_type", None)
            return create_notification(**kwargs)
        raise


def _preview_for_notification(row) -> str:
    if not row:
        return "New message"
    kind = row.get("kind") or "text"
    body = (row.get("body") or "").strip()
    if kind == "text":
        return body[:140] or "New message"
    if kind == "image":
        return "📷 Photo"
    if kind == "voice":
        return "🎤 Voice note"
    if kind == "video":
        return "🎬 Video"
    if kind == "file":
        return "📎 File"
    if kind == "location":
        return "📍 Location"
    if kind == "contact":
        return "👤 Contact"
    if kind == "system":
        return body or "System message"
    return body or "New message"

# ---------------------------------------------------------------------------
# Connection registry.
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

    async def send_to_users(
        self,
        users,
        data: str,
        exclude: WebSocket | None = None,
    ) -> set[str]:
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

        out.append({"url": url, "domain": domain})

        if len(out) >= 5:
            break

    return out


def _canonical_username(cursor, name: str):
    name = (name or "").strip()
    if not name:
        return None

    cursor.execute("SELECT username FROM users WHERE username = %s", (name,))
    row = cursor.fetchone()
    if row:
        return row["username"]

    cursor.execute(
        "SELECT username FROM users WHERE lower(username) = lower(%s)",
        (name,),
    )
    row = cursor.fetchone()
    return row["username"] if row else None


def _resolve_viewer(viewer_raw: str):
    """
    Compatibility helper used by chat_features.py.

    Resolves a viewer username safely using the pooled DB connection.
    """
    if not viewer_raw:
        return None

    try:
        with db() as conn:
            cursor = conn.cursor()
            return _canonical_username(cursor, viewer_raw)
    except Exception:
        return None


def _is_member(cursor, conv_id: int, user: str) -> bool:
    cursor.execute(
        "SELECT 1 FROM chat_members WHERE conversation_id=%s AND user_name=%s",
        (conv_id, user),
    )
    return cursor.fetchone() is not None


def _member_names(cursor, conv_id: int) -> list[str]:
    cursor.execute(
        "SELECT user_name FROM chat_members WHERE conversation_id=%s",
        (conv_id,),
    )
    return [r["user_name"] for r in cursor.fetchall()]


def _member_names_from_id(conv_id: int) -> list[str]:
    try:
        with db() as conn:
            cursor = conn.cursor()
            return _member_names(cursor, conv_id)
    except Exception:
        return []


def _is_blocked_direct(cursor, conv_id: int, viewer: str) -> bool:
    """
    For direct conversations, block both directions if either user blocked
    the other. Group blocking policy is deferred.
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
    Opening/reading a chat clears per-user mark-unread and records last
    opened time. Does not alter archive/mute/pin.
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


# ---------------------------------------------------------------------------
# Async-safe DB helpers for broadcast.
# ---------------------------------------------------------------------------

def _record_deliveries_sync(conv_id: int, msg_id: int, users: list[str]):
    try:
        with db() as conn:
            cursor = conn.cursor()

            for u in users:
                _record_delivery(cursor, conv_id, u, msg_id)

            conn.commit()
    except Exception as exc:
        # Was a silent `except: pass`. Delivery receipts are non-critical, but a
        # failure here often shares a root cause with notify failures (stale
        # socket / pool exhaustion), so log it to make the pattern visible.
        _notify_log.warning(
            "delivery record failed conv=%s msg=%s: %s", conv_id, msg_id, exc
        )


def _notify_chat_targets_sync(
    conv_id: int,
    msg_id: int,
    sender: str,
    title: str,
    preview: str,
    generic_targets: list[str],
    mentioned: list[str],
):
    """
    Write unified notification rows for offline (undelivered) recipients and
    for @-mentioned members. Runs in its OWN db() transaction.

    HARDENED (replaces the previous silent `except Exception: pass`):
      - EACH recipient is isolated behind a SAVEPOINT. A mid-transaction Neon
        drop on one recipient (query_wait_timeout / "SSL connection has been
        closed unexpectedly" / "Terminating connection due to administrator
        command") rolls back ONLY that recipient, so the rows already written
        for the others survive the final commit. Previously one blip killed
        every notification for the message.
      - Every failure is logged under 'chat.notify'. Silence is impossible now.
      - Muted recipients are skipped (logged at debug).
      - Live-delivered, non-mentioned recipients are intentionally NOT in
        generic_targets (computed by the caller); that skip is by design and is
        logged by the caller so "old rows show, new rows don't" can be told
        apart from "broken".
    """
    try:
        with db() as conn:
            cursor = conn.cursor()

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

            # Build the job list once so savepoint names are unique per slot.
            jobs: list[tuple[str, str, str, str | None]] = []
            for u in generic_targets:
                jobs.append((u, "messages", "chat_message", "message"))
            for u in mentioned:
                jobs.append((u, "mentions", "chat_mention", "mention"))

            for i, (user, category, ntype, legacy) in enumerate(jobs):
                if _muted(user):
                    _notify_log.debug(
                        "notify skip muted user=%s conv=%s msg=%s",
                        user, conv_id, msg_id,
                    )
                    continue

                sp = f"ntf_{i}"
                try:
                    cursor.execute(f"SAVEPOINT {sp}")
                except Exception:
                    # If SAVEPOINT itself is unavailable (very old backend /
                    # odd pool state), fall through; the inner try/except still
                    # catches and logs a per-recipient failure.
                    sp = None

                try:
                    _create_notification(
                        user_name=user,
                        category=category,
                        type=ntype,
                        legacy_type=legacy,
                        title=title,
                        body=preview,
                        actor=sender,
                        source_type="conversation",
                        source_id=conv_id,
                        secondary_id=msg_id,
                        data={"conversation_id": conv_id, "message_id": msg_id},
                        cursor=cursor,
                    )

                    if sp:
                        try:
                            cursor.execute(f"RELEASE SAVEPOINT {sp}")
                        except Exception:
                            pass

                    _notify_log.debug(
                        "notify ok user=%s cat=%s conv=%s msg=%s",
                        user, category, conv_id, msg_id,
                    )
                except Exception as exc:
                    if sp:
                        try:
                            cursor.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                        except Exception:
                            pass
                    _notify_log.warning(
                        "chat notify FAILED user=%s cat=%s conv=%s msg=%s: %s",
                        user, category, conv_id, msg_id, exc,
                    )

            conn.commit()

    except Exception as exc:
        # Best-effort: a notify failure must never crash the broadcast, but it
        # must NEVER be silent again. This replaces the original
        # `except Exception: pass` that destroyed new rows invisibly.
        _notify_log.error(
            "notify pass failed conv=%s msg=%s: %s", conv_id, msg_id, exc
        )


async def _broadcast_message(
    row: dict,
    conv_id: int,
    sender: str,
    sender_ws: WebSocket | None = None,
):
    if not row:
        return

    member_list = await asyncio.to_thread(_member_names_from_id, conv_id)
    members = set(member_list)
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
        await asyncio.to_thread(
            _record_deliveries_sync,
            conv_id,
            msg_id,
            list(recipient_deliveries),
        )

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
        tokens = {
            t.lower()
            for t in re.findall(r"@([A-Za-z0-9_.\-]+)", row.get("body") or "")
        }
        if tokens:
            lower_members = {m.lower(): m for m in members if m != sender}
            for tk in tokens:
                if tk in lower_members:
                    mentioned.add(lower_members[tk])

    undelivered = members - delivered - {sender}

    # Mentioned members get a dedicated mention notification, not a generic message one.
    generic_targets = undelivered - mentioned

    # Log the by-design skip so "new rows don't appear" is explainable: a
    # recipient who is online and not mentioned already saw the message live.
    live_skipped = (members - {sender}) - undelivered - mentioned
    if live_skipped:
        _notify_log.debug(
            "notify skip live-delivered (no row by design) users=%s conv=%s msg=%s",
            sorted(live_skipped), conv_id, msg_id,
        )

    preview = _preview_for_notification(row)
    title = row.get("sender_display") or sender

    if generic_targets or mentioned:
        await asyncio.to_thread(
            _notify_chat_targets_sync,
            conv_id,
            msg_id,
            sender,
            title,
            preview,
            list(generic_targets),
            list(mentioned),
        )


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

        _create_notification(
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


# ---------------------------------------------------------------------------
# REST: join request
# ---------------------------------------------------------------------------

@router.post("/chat/conversations/{conv_id}/join-request")
def request_group_join(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    message = (data.get("message") or "").strip()[:300] or None

    try:
        with db() as conn:
            cursor = conn.cursor()

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

            cursor.execute(
                "SELECT name FROM chat_conversations WHERE id = %s",
                (conv_id,),
            )
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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: discover groups
# ---------------------------------------------------------------------------

@router.get("/chat/discover")
def discover_groups(viewer: str = "", q: str = "", limit: int = 30):
    limit = max(1, min(int(limit or 30), 50))
    query = (q or "").strip()
    search = f"%{query}%" if query else None

    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

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
                (viewer, viewer, search, search, search, limit),
            )

            rows = [dict(r) for r in cursor.fetchall()]
            return {"groups": rows}

    except Exception as e:
        return {"error": str(e)}


@router.get("/chat/conversations/{conv_id}/join-requests")
def list_group_join_requests(conv_id: int, viewer: str = "", status: str = "pending"):
    try:
        with db() as conn:
            cursor = conn.cursor()

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

    except Exception as e:
        return {"error": str(e)}


@router.post("/chat/conversations/{conv_id}/join-requests/{request_id}/approve")
def approve_group_join_request(conv_id: int, request_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    try:
        with db() as conn:
            cursor = conn.cursor()

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

            cursor.execute(
                "SELECT name FROM chat_conversations WHERE id = %s",
                (conv_id,),
            )
            group = cursor.fetchone()
            group_name = (group or {}).get("name") or "the group"

            _create_notification(
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
        return {"error": str(e)}


@router.post("/chat/conversations/{conv_id}/join-requests/{request_id}/reject")
def reject_group_join_request(conv_id: int, request_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    try:
        with db() as conn:
            cursor = conn.cursor()

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

            cursor.execute(
                "SELECT name FROM chat_conversations WHERE id = %s",
                (conv_id,),
            )
            group = cursor.fetchone()
            group_name = (group or {}).get("name") or "the group"

            _create_notification(
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
        return {"error": str(e)}


@router.delete("/chat/conversations/{conv_id}/join-request")
def cancel_group_join_request(conv_id: int, viewer: str = ""):
    try:
        with db() as conn:
            cursor = conn.cursor()

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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# WebSocket blocking-safe helpers.
# ---------------------------------------------------------------------------

def _ws_auth_and_presence_sync(raw_viewer: str):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, raw_viewer)

            if viewer:
                _set_presence(cursor, viewer, True)
                conn.commit()

            return viewer

    except Exception:
        return None


def _set_presence_offline_sync(user: str):
    try:
        with db() as conn:
            cursor = conn.cursor()
            _set_presence(cursor, user, False)
            conn.commit()
    except Exception:
        pass


def _ws_check_member_sync(conv_id: int, viewer: str) -> bool:
    try:
        with db() as conn:
            cursor = conn.cursor()
            return _is_member(cursor, conv_id, viewer)
    except Exception:
        return False


def _ws_send_message_sync(
    viewer: str,
    conv_id,
    kind: str,
    body: str,
    reply_to_id,
    forwarded_from_id,
    meta: dict,
):
    try:
        with db() as conn:
            cursor = conn.cursor()

            if conv_id is None:
                return {"error": "conversation_id required"}

            if not _is_member(cursor, conv_id, viewer):
                return {"error": "not a member"}

            if _is_blocked_direct(cursor, conv_id, viewer):
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

            if row is None:
                return {"error": "message not found after insert"}

            return {"row": row, "conv_id": conv_id}

    except Exception as e:
        return {"error": str(e)}


def _ws_mark_read_sync(viewer: str, conv_id: int, last_id: int) -> bool:
    try:
        with db() as conn:
            cursor = conn.cursor()

            if not _is_member(cursor, conv_id, viewer):
                return False

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
            return True

    except Exception:
        return False


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@router.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    raw_viewer = websocket.query_params.get("viewer", "").strip()
    if not raw_viewer:
        await websocket.close(code=4401)
        return

    viewer = await asyncio.to_thread(_ws_auth_and_presence_sync, raw_viewer)

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
                await websocket.send_text(
                    json.dumps({"type": "error", "error": "bad json"})
                )
                continue

            ctype = data.get("type")

            # ---- ping/pong heartbeat ----
            if ctype == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            # ---- send a message ----
            elif ctype == "message":
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

                result = await asyncio.to_thread(
                    _ws_send_message_sync,
                    viewer,
                    conv_id,
                    kind,
                    body,
                    reply_to_id,
                    forwarded_from_id,
                    meta,
                )

                if result.get("error"):
                    await websocket.send_text(
                        json.dumps({
                            "type": "error",
                            "temp_id": temp_id,
                            "conversation_id": conv_id,
                            "error": result["error"],
                        })
                    )
                    continue

                row = result.get("row")
                conv_id = result.get("conv_id")

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
                    json.dumps(
                        {"type": "ack", "temp_id": temp_id, "message": row},
                        default=str,
                    )
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

                ok = await asyncio.to_thread(_ws_mark_read_sync, viewer, conv_id, last_id)
                if not ok:
                    continue

                members = await asyncio.to_thread(_member_names_from_id, conv_id)
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

                member = await asyncio.to_thread(_ws_check_member_sync, conv_id, viewer)
                if not member:
                    continue

                members = await asyncio.to_thread(_member_names_from_id, conv_id)
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

                member = await asyncio.to_thread(_ws_check_member_sync, conv_id, viewer)
                if not member:
                    continue

                members = await asyncio.to_thread(_member_names_from_id, conv_id)
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
            await asyncio.to_thread(_set_presence_offline_sync, viewer)
        except Exception:
            pass

        await manager.disconnect(viewer, websocket)


# ---------------------------------------------------------------------------
# REST: conversation list
# ---------------------------------------------------------------------------

@router.get("/chat/conversations")
def list_conversations(viewer: str = "", include_archived: bool = False):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

            cursor.execute(
                """
                SELECT c.id, c.kind, c.name, c.image_url, c.description,
                       c.join_mode,
                       c.allow_member_invites,
                       c.announce_new_members,
                       c.category,
                       c.scene,
                       c.tags,
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
                    viewer,
                    viewer,
                    viewer,
                    viewer,
                    viewer,
                    viewer,
                    viewer,
                    viewer,
                    include_archived,
                ),
            )

            rows = [dict(r) for r in cursor.fetchall()]

            for r in rows:
                _localize(r, "updated_at", "pinned_at", "last_at", "counterpart_last_seen_at")

            return {"conversations": rows}

    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: starred messages
# ---------------------------------------------------------------------------

@router.get("/chat/starred")
def list_starred_messages(viewer: str = "", limit: int = 100):
    limit = max(1, min(int(limit or 100), 200))

    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

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

            return {"messages": messages}

    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: pinned messages
# ---------------------------------------------------------------------------

@router.get("/chat/conversations/{conv_id}/pinned")
def list_pinned_messages(conv_id: int, viewer: str = ""):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

            if not _is_member(cursor, conv_id, viewer):
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

            return {"messages": messages}

    except Exception as e:
        return {"error": str(e)}


@router.post("/chat/messages/{message_id}/pin")
def pin_message(message_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    try:
        with db() as conn:
            cursor = conn.cursor()

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
                SET meta = COALESCE(meta, '{}'::jsonb) || %s::jsonb
                WHERE id = %s
                """,
                (
                    json.dumps({
                        "pinned_at": int(_dt.datetime.now(_dt.timezone.utc).timestamp()),
                        "pinned_by": viewer,
                    }),
                    message_id,
                ),
            )

            message = _message_row(cursor, message_id, viewer)
            conn.commit()
            return {"message": message}

    except Exception as e:
        return {"error": str(e)}


@router.post("/chat/messages/{message_id}/unpin")
def unpin_message(message_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    try:
        with db() as conn:
            cursor = conn.cursor()

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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: reaction detail
# ---------------------------------------------------------------------------

@router.get("/chat/messages/{message_id}/reactions")
def message_reaction_detail(message_id: int, viewer: str = ""):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

            cursor.execute(
                "SELECT conversation_id FROM chat_messages WHERE id = %s AND deleted_at IS NULL",
                (message_id,),
            )
            row = cursor.fetchone()

            if not row:
                return {"error": "message not found"}

            if not _is_member(cursor, row["conversation_id"], viewer):
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
            return {"reactions": rows}

    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: clear chat for me
# ---------------------------------------------------------------------------

@router.post("/chat/conversations/{conv_id}/clear")
def clear_conversation_for_me(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    try:
        with db() as conn:
            cursor = conn.cursor()

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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: mark all chats read
# ---------------------------------------------------------------------------

@router.post("/chat/read-all")
def mark_all_chats_read(data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    try:
        with db() as conn:
            cursor = conn.cursor()

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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: mute with duration
# ---------------------------------------------------------------------------

@router.post("/chat/conversations/{conv_id}/mute")
def mute_conversation_endpoint(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    if not viewer_raw:
        return {"error": "viewer required"}

    hours = data.get("hours", None)

    try:
        with db() as conn:
            cursor = conn.cursor()

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
                        conversation_id, user_name,
                        archived, muted, pinned, pinned_at,
                        muted_until, last_opened_at, mark_unread, updated_at
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
                            conversation_id, user_name,
                            archived, muted, pinned, pinned_at,
                            muted_until, last_opened_at, mark_unread, updated_at
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
                            conversation_id, user_name,
                            archived, muted, pinned, pinned_at,
                            muted_until, last_opened_at, mark_unread, updated_at
                        )
                        VALUES (%s, %s, FALSE, TRUE, FALSE, NULL,
                                CURRENT_TIMESTAMP + make_interval(hours => %s),
                                CURRENT_TIMESTAMP, FALSE, CURRENT_TIMESTAMP)
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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: create a conversation (direct or group)
# ---------------------------------------------------------------------------

@router.post("/chat/conversations")
def create_conversation(data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    kind = data.get("kind", "direct")

    try:
        with db() as conn:
            cursor = conn.cursor()

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

                cursor.execute(
                    "SELECT id FROM chat_conversations WHERE pair_key = %s",
                    (pk,),
                )
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
                        kind, name, image_url, description, created_by,
                        join_mode, allow_member_invites, announce_new_members
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
                    _create_notification(
                        user_name=member,
                        category="groups",
                        type="group_invite",
                        legacy_type="group_invite",
                        title=f"{viewer} added you to {name}",
                        body="",
                        actor=viewer,
                        source_type="conversation",
                        source_id=conv_id,
                        data={"conversation_id": conv_id},
                        cursor=cursor,
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
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: group members
# ---------------------------------------------------------------------------

@router.get("/chat/conversations/{conv_id}/members")
def get_members(conv_id: int, viewer: str = ""):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

            if not _is_member(cursor, conv_id, viewer):
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

            return {"members": rows}

    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST: add a member to a group
# ---------------------------------------------------------------------------

@router.post("/chat/conversations/{conv_id}/members")
def add_member(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    target_raw = (data.get("user_name") or "").strip()

    if not viewer_raw or not target_raw:
        return {"error": "viewer and user_name required"}

    try:
        with db() as conn:
            cursor = conn.cursor()

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

            cursor.execute(
                "SELECT name FROM chat_conversations WHERE id = %s",
                (conv_id,),
            )
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

            _create_notification(
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
        return {"error": str(e)}


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
    if after_id and not since:
        since = after_id

    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer)
            if not viewer:
                return {"error": "viewer required"}

            if not _is_member(cursor, conv_id, viewer):
                return {"error": "not a member"}

            page_limit = max(1, min(int(limit or 50), 200))
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

            return {
                "messages": messages,
                "read_cursors": read_cursors,
                "delivered_cursors": delivered_cursors,
                "has_more_older": has_more_older,
                "has_more_newer": has_more_newer,
            }

    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# REST sync helpers for async fallback endpoints.
# ---------------------------------------------------------------------------

def _send_rest_db_sync(
    viewer_raw: str,
    conv_id: int,
    kind: str,
    body: str,
    reply_to_id,
    forwarded_from_id,
    meta: dict,
):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer_raw)
            if not viewer:
                return {"error": "unknown viewer"}

            if not _is_member(cursor, conv_id, viewer):
                return {"error": "not a member"}

            if _is_blocked_direct(cursor, conv_id, viewer):
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

            if row is None:
                return {"error": "message not found after insert"}

            return {"viewer": viewer, "row": row}

    except Exception as e:
        return {"error": str(e)}


def _mark_read_rest_sync(viewer_raw: str, conv_id: int, last_id: int):
    try:
        with db() as conn:
            cursor = conn.cursor()

            viewer = _canonical_username(cursor, viewer_raw)
            if not viewer:
                return {"error": "unknown viewer"}

            if not _is_member(cursor, conv_id, viewer):
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

            return {"viewer": viewer}

    except Exception as e:
        return {"error": str(e)}


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

    result = await asyncio.to_thread(
        _send_rest_db_sync,
        viewer_raw,
        conv_id,
        kind,
        body,
        reply_to_id,
        forwarded_from_id,
        meta,
    )

    if result.get("error"):
        return {"error": result["error"]}

    viewer = result["viewer"]
    row = result["row"]

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

    result = await asyncio.to_thread(_mark_read_rest_sync, viewer_raw, conv_id, last_id)

    if result.get("error"):
        return {"error": result["error"]}

    viewer = result["viewer"]

    members = await asyncio.to_thread(_member_names_from_id, conv_id)
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


# ---------------------------------------------------------------------------
# Pool health
# ---------------------------------------------------------------------------

@router.get("/chat/health")
def chat_health():
    stats = {}

    try:
        if POOL is not None:
            stats = POOL.get_stats()
    except Exception as e:
        stats = {"pool_error": str(e)}

    return {
        "ok": True,
        "service": "chat",
        "pool": stats,
        "pool_min": CHAT_POOL_MIN,
        "pool_max": CHAT_POOL_MAX,
        "statement_timeout_ms_informational_only": CHAT_DB_STATEMENT_TIMEOUT_MS,
        "idle_in_transaction_timeout_ms_informational_only": CHAT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    }