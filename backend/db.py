# backend/db.py
#
# Connection pooling + schema bootstrap + performance indexes.
#
# This replaces the old pattern where every request created a fresh
# psycopg2 connection. Your measured cold connection cost was around:
#
#   connect + SELECT 1: 2469 ms
#   connect + SELECT 1: 2504 ms
#   connect + SELECT 1: 3139 ms
#
# With pooling, that cost is paid once per pooled connection, not once
# per HTTP request.
#
# UPDATED FOR NEON:
# - Every get_db() pre-pings the pooled connection with SELECT 1.
# - Dead/stale SSL sockets ("SSL connection has been closed unexpectedly",
#   "server closed the connection unexpectedly", etc.) are discarded
#   (putconn close=True) and a fresh connection is tried, up to 3 attempts.
# - PooledConnection marks itself broken when a stale error occurs mid-use,
#   so close() discards it instead of returning a dead socket to the pool.
# - Neon pooled-endpoint safe: no unsupported startup options are passed.
#   (PgBouncer on Neon only accepts: client_encoding, datestyle, timezone,
#    standard_conforming_strings, application_name.)
#

import os
import threading
import time

import psycopg2
from psycopg2 import InterfaceError, OperationalError
from psycopg2 import pool
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Load backend/.env first. If missing, try project-root /.env.
if not load_dotenv(os.path.join(BASE_DIR, ".env")):
    load_dotenv(os.path.join(BASE_DIR, "..", ".env"))


DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL missing - check your .env file")


_pool = None
_pool_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Stale connection detection
# ---------------------------------------------------------------------------

_STALE_DB_MARKERS = (
    "ssl connection has been closed unexpectedly",
    "server closed the connection unexpectedly",
    "connection already closed",
    "terminated by administrator command",
    "could not receive data from server",
    "could not send data to server",
    "connection reset by peer",
    "unexpected eof on client connection",
    "the connection is closed",
    "pq_getmessage: unexpected eof",
    "ssl send: closed",
)


def _is_stale_db_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _STALE_DB_MARKERS)


# ---------------------------------------------------------------------------
# Pool setup
# ---------------------------------------------------------------------------
def _init_pool():
    global _pool

    if _pool is not None:
        return

    with _pool_lock:
        if _pool is not None:
            return

        minconn = int(os.getenv("DB_POOL_MIN", "1"))
        maxconn = int(os.getenv("DB_POOL_MAX", "6"))

        if minconn < 1:
            minconn = 1

        if maxconn < minconn:
            maxconn = minconn

        _pool = pool.ThreadedConnectionPool(
            minconn=minconn,
            maxconn=maxconn,
            dsn=DATABASE_URL,
            cursor_factory=RealDictCursor,
            connect_timeout=int(os.getenv("DB_CONNECT_TIMEOUT", "10")),
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )


class PooledConnection:
    """
    Drop-in wrapper.

    Existing code can keep doing:

        conn = get_db()
        cursor = conn.cursor()
        conn.commit()
        conn.rollback()
        conn.close()

    But conn.close() returns the connection to the pool instead of
    destroying it — UNLESS the connection went stale during use, in
    which case close() discards it so the pool never hands out a dead
    socket again.
    """

    __slots__ = ("_conn", "_pool", "_closed", "_broken")

    def __init__(self, conn, p):
        self._conn = conn
        self._pool = p
        self._closed = False
        self._broken = False

    def _mark_broken(self, exc):
        if _is_stale_db_error(exc):
            self._broken = True

    def cursor(self, *args, **kwargs):
        if self._closed:
            raise RuntimeError("Cannot use a pooled connection after close()")
        try:
            return self._conn.cursor(*args, **kwargs)
        except (InterfaceError, OperationalError) as exc:
            self._mark_broken(exc)
            raise

    def commit(self):
        if self._closed:
            raise RuntimeError("Cannot commit a pooled connection after close()")
        try:
            return self._conn.commit()
        except (InterfaceError, OperationalError) as exc:
            self._mark_broken(exc)
            raise

    def rollback(self):
        if self._closed:
            return
        try:
            self._conn.rollback()
        except Exception as exc:
            self._mark_broken(exc)

    def close(self):
        if self._closed:
            return

        self._closed = True

        # If the caller left a transaction open, roll it back before
        # returning the connection to the pool.
        try:
            self._conn.rollback()
        except Exception as exc:
            self._mark_broken(exc)

        # Discard broken/stale sockets instead of poisoning the pool.
        if self._broken:
            try:
                self._pool.putconn(self._conn, close=True)
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
            return

        try:
            self._pool.putconn(self._conn)
        except Exception:
            # If putting it back fails, close the physical connection so
            # the pool does not keep a broken connection alive.
            try:
                self._conn.close()
            except Exception:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self._mark_broken(exc)
        self.close()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def get_db(timeout=10.0):
    """
    Get a pooled DB connection.

    Pre-pings the connection with SELECT 1. If the socket is stale
    (Neon/PgBouncer closed it after idle), the dead connection is
    discarded and a fresh one is tried, up to 3 attempts.

    If the pool is temporarily exhausted, wait briefly instead of
    failing immediately. This helps during community-page request
    fan-out.
    """
    _init_pool()

    deadline = time.monotonic() + float(timeout)
    last_exc = None

    for attempt in range(3):
        # Acquire a connection from the pool (with exhaustion wait).
        conn = None
        acquire_deadline = time.monotonic() + float(timeout)

        while True:
            try:
                conn = _pool.getconn()
                break
            except pool.PoolError as exc:
                last_exc = exc
                if time.monotonic() >= acquire_deadline:
                    raise
                time.sleep(0.05)

        # Pre-ping: catch dead SSL sockets BEFORE the caller runs a query.
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            cursor.fetchone()
            cursor.close()
        except (InterfaceError, OperationalError) as exc:
            last_exc = exc
            # Discard the dead socket so it never re-enters the pool.
            try:
                _pool.putconn(conn, close=True)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass

            if attempt == 2 or not _is_stale_db_error(exc):
                raise

            time.sleep(0.3 * (attempt + 1))
            continue

        return PooledConnection(conn, _pool)

    # Should not normally reach here, but keep the contract honest.
    if last_exc is not None:
        raise last_exc

    raise RuntimeError("could not acquire a healthy database connection")


def get_pool_stats():
    """
    Pool statistics for health endpoints.
    """
    _init_pool()

    try:
        return _pool.get_stats()
    except Exception as exc:
        return {"pool_error": str(exc)}


def warm_pool(n=3):
    """
    Optional: pre-open a few connections at startup so the first requests
    do not pay the cold-connect cost.

    You can call this from main.py startup:

        from db import warm_pool
        warm_pool(3)
    """
    _init_pool()

    conns = []

    try:
        for _ in range(max(0, int(n))):
            conns.append(_pool.getconn())
    except pool.PoolError:
        pass
    finally:
        for c in conns:
            try:
                _pool.putconn(c)
            except Exception:
                pass


def close_pool():
    """
    Optional: clean teardown on shutdown.
    """
    global _pool

    with _pool_lock:
        if _pool is None:
            return

        try:
            _pool.closeall()
        except Exception:
            pass

        _pool = None


def _rollback(conn):
    if not conn:
        return
    try:
        conn.rollback()
    except Exception:
        pass


def _close(conn):
    if not conn:
        return
    try:
        conn.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Schema bootstrap
# ---------------------------------------------------------------------------
def init_db():
    """
    Idempotent schema creation/migration.

    Safe to run on every boot.
    """
    conn = None

    try:
        conn = get_db()
        cursor = conn.cursor()

        # ============ FEED TABLES ============
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                image_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS price TEXT")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS likes (
                post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                user_name TEXT,
                PRIMARY KEY (post_id, user_name)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                user_name TEXT,
                body TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text'")
        cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS comment_likes (
                comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
                user_name TEXT,
                PRIMARY KEY (comment_id, user_name)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS follows (
                follower TEXT,
                followee TEXT,
                PRIMARY KEY (follower, followee)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS bids (
                id SERIAL PRIMARY KEY,
                post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                user_name TEXT,
                amount NUMERIC(12,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # ============ AUCTION TABLES (Legacy Floor) ============
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS auctions (
                id SERIAL PRIMARY KEY,
                host_username TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                image_url TEXT,
                tier TEXT NOT NULL DEFAULT 'open',
                starting_bid NUMERIC(12,2) DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'upcoming',
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                ticket_price NUMERIC(12,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_type TEXT DEFAULT 'external'")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_url TEXT DEFAULT ''")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_peer_id TEXT DEFAULT ''")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS invitations (
                id SERIAL PRIMARY KEY,
                auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                UNIQUE (auction_id, user_name)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (auction_id, user_name)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS auction_bids (
                id SERIAL PRIMARY KEY,
                auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                amount NUMERIC(12,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # ============ SALES TABLES (Live Broadcast System) ============
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS lots (
                id SERIAL PRIMARY KEY,
                sale_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                image_url TEXT,
                starting_price NUMERIC(12,2) DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'sealed',
                sold_price NUMERIC(12,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS lot_bids (
                id SERIAL PRIMARY KEY,
                lot_id INTEGER REFERENCES lots(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                amount NUMERIC(12,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS bookmarks (
                post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                user_name TEXT,
                PRIMARY KEY (post_id, user_name)
            )
            """
        )

        cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'")
        cursor.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS code TEXT")
        cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_sale_user ON tickets (auction_id, user_name)")
        cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_code ON tickets (code)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS stories (
                id SERIAL PRIMARY KEY,
                user_name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'image',
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            )
            """
        )

        # ---- STORY INTERACTIONS ----
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS story_likes (
                story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
                user_name TEXT,
                PRIMARY KEY (story_id, user_name)
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS story_comments (
                id SERIAL PRIMARY KEY,
                story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # The money ledger — append-only, balance = SUM(amount).
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS ledger_entries (
                id SERIAL PRIMARY KEY,
                user_name TEXT NOT NULL,
                amount NUMERIC(12,2) NOT NULL,
                kind TEXT NOT NULL,
                reference TEXT,
                ref_table TEXT,
                ref_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries (user_name, created_at DESC)")

        # VIP subscription truth table.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS vip_subscriptions (
                user_name TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'active',
                price NUMERIC(12,2) NOT NULL DEFAULT 0,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                renews_at TIMESTAMP NOT NULL,
                cancelled_at TIMESTAMP,
                last_charged_at TIMESTAMP,
                periods_paid INTEGER NOT NULL DEFAULT 0,
                failure_reason TEXT
            )
            """
        )

        # ============ CHAT (1:1 + groups, websocket-delivered) ============
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_conversations (
                id SERIAL PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'direct',
                name TEXT,
                image_url TEXT,
                description TEXT,
                pair_key TEXT,
                created_by TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS description TEXT")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")

        cursor.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_direct_pair
            ON chat_conversations (pair_key)
            WHERE pair_key IS NOT NULL
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_members (
                conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_name)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id BIGSERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                sender TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'text',
                body TEXT NOT NULL,
                reply_to_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
                forwarded_from_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
                meta JSONB NOT NULL DEFAULT '{}'::jsonb,
                edited_at TIMESTAMP,
                deleted_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL")
        cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL")
        cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb")
        cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP")
        cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP")

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_reply ON chat_messages (reply_to_id) WHERE reply_to_id IS NOT NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_forwarded ON chat_messages (forwarded_from_id) WHERE forwarded_from_id IS NOT NULL")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_reads (
                conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                last_read_id BIGINT NOT NULL DEFAULT 0,
                last_delivered_id BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, user_name)
            )
            """
        )

        cursor.execute("ALTER TABLE chat_reads ADD COLUMN IF NOT EXISTS last_delivered_id BIGINT NOT NULL DEFAULT 0")

        # ============ MESSENGER FEATURE SCHEMA ============

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_message_hidden (
                message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                hidden_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (message_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_hidden_user ON chat_message_hidden (user_name)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_starred_messages (
                message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                starred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (message_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_starred_user ON chat_starred_messages (user_name, starred_at DESC)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_reactions (
                message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (message_id, user_name, emoji)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions (message_id)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_drafts (
                conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_drafts_user ON chat_drafts (user_name)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_conversation_prefs (
                conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                archived BOOLEAN NOT NULL DEFAULT FALSE,
                muted BOOLEAN NOT NULL DEFAULT FALSE,
                pinned BOOLEAN NOT NULL DEFAULT FALSE,
                pinned_at TIMESTAMP,
                muted_until TIMESTAMP,
                last_opened_at TIMESTAMP,
                mark_unread BOOLEAN NOT NULL DEFAULT FALSE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_prefs_user ON chat_conversation_prefs (user_name)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_blocks (
                blocker TEXT NOT NULL,
                blocked TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (blocker, blocked)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON chat_blocks (blocked)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_reports (
                id SERIAL PRIMARY KEY,
                reporter TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id BIGINT,
                target_text TEXT,
                reason TEXT NOT NULL,
                details TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reports_reporter ON chat_reports (reporter, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports (status, created_at DESC)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_presence (
                user_name TEXT PRIMARY KEY,
                online BOOLEAN NOT NULL DEFAULT FALSE,
                last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_notifications (
                id SERIAL PRIMARY KEY,
                user_name TEXT NOT NULL,
                conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
                message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                title TEXT,
                body TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                read_at TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_user ON chat_notifications (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_unread ON chat_notifications (user_name, read_at, created_at DESC)")

        # ============ COMMUNITY / NOTIFICATIONS / SETTINGS ============

        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS join_mode TEXT NOT NULL DEFAULT 'request'")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS allow_member_invites BOOLEAN NOT NULL DEFAULT FALSE")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS announce_new_members BOOLEAN NOT NULL DEFAULT FALSE")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS category TEXT")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS scene TEXT")
        cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS group_join_requests (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                message TEXT,
                reviewed_by TEXT,
                reviewed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (group_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_gjr_group_status ON group_join_requests (group_id, status)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_name TEXT NOT NULL,
                category TEXT NOT NULL,
                type TEXT NOT NULL,
                actor TEXT,
                source_type TEXT,
                source_id INTEGER,
                secondary_id INTEGER,
                title TEXT NOT NULL,
                body TEXT,
                data JSONB NOT NULL DEFAULT '{}'::jsonb,
                read_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_name, read_at, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications (source_type, source_id)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS user_settings (
                user_name TEXT PRIMARY KEY,
                language TEXT NOT NULL DEFAULT 'en',
                notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
                auctions JSONB NOT NULL DEFAULT '{}'::jsonb,
                privacy JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS community_calls (
                id SERIAL PRIMARY KEY,
                host_user_name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'open_call',
                title TEXT NOT NULL,
                description TEXT,
                cover_url TEXT,
                scene TEXT,
                location TEXT,
                online BOOLEAN NOT NULL DEFAULT FALSE,
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                deadline_at TIMESTAMP,
                status TEXT NOT NULL DEFAULT 'open',
                eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
                apply_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_status_deadline ON community_calls (status, deadline_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_host ON community_calls (host_user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_scene ON community_calls (scene) WHERE scene IS NOT NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_kind ON community_calls (kind)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS call_interest (
                id SERIAL PRIMARY KEY,
                call_id INTEGER NOT NULL REFERENCES community_calls(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (call_id, user_name)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_interest_user ON call_interest (user_name, created_at DESC)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS call_reminders (
                id SERIAL PRIMARY KEY,
                call_id INTEGER NOT NULL REFERENCES community_calls(id) ON DELETE CASCADE,
                user_name TEXT NOT NULL,
                window_days INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (call_id, user_name, window_days)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_reminders_call ON call_reminders (call_id, window_days)")

        # ============ MULTI-CURRENCY + ESCROW-READY LEDGER FOUNDATION ============

        cursor.execute("ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE lot_bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS ticket_currency TEXT NOT NULL DEFAULT 'NGN'")
        cursor.execute("ALTER TABLE vip_subscriptions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")

        # Settlement / blind-lot columns.
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS winner_username TEXT")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS reserve NUMERIC(12,2)")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS estimate_low NUMERIC(12,2)")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS estimate_high NUMERIC(12,2)")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS hammer_at TIMESTAMP")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'")

        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS payment_reference TEXT")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS payment_updated_at TIMESTAMP")
        cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS checkout_url TEXT")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS ticket_capacity INTEGER")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'none'")
        cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS payout_reference TEXT")
        cursor.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'purchased'")

        # Invariants.
        cursor.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_one_lot_on_block
            ON lots (sale_id)
            WHERE status = 'on_block'
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ledger_acct_cur ON ledger_entries (user_name, currency, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lots_sale_status ON lots (sale_id, status)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS payment_events (
                id SERIAL PRIMARY KEY,
                provider TEXT NOT NULL,
                event_id TEXT NOT NULL,
                type TEXT NOT NULL,
                account TEXT,
                currency TEXT,
                amount NUMERIC(12,2),
                reference TEXT,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                processed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (provider, event_id)
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_payment_events_account ON payment_events (account, created_at DESC)")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS house_payout_profiles (
                user_name TEXT PRIMARY KEY,
                business_name TEXT,
                bank_code TEXT,
                account_number TEXT,
                account_name TEXT,
                currency TEXT NOT NULL DEFAULT 'NGN',
                paystack_subaccount_code TEXT,
                paystack_recipient_code TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_house_payout_status ON house_payout_profiles (status)")

        # ============ WIDEN MONEY COLUMNS TO NUMERIC(18,2) ============
        cursor.execute(
            """
            DO $$
            DECLARE
              pair text; tbl text; col text;
              pairs text[] := ARRAY[
                'auctions.ticket_price','lots.starting_price','lots.reserve',
                'lots.estimate_low','lots.estimate_high','lots.sold_price',
                'lot_bids.amount','ledger_entries.amount'
              ];
            BEGIN
              FOREACH pair IN ARRAY pairs LOOP
                tbl := split_part(pair, '.', 1);
                col := split_part(pair, '.', 2);
                IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=tbl AND column_name=col
                    AND data_type='numeric'
                    AND (numeric_precision IS DISTINCT FROM 18 OR numeric_scale IS DISTINCT FROM 2)
                ) THEN
                  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(18,2)', tbl, col);
                END IF;
              END LOOP;
            END $$;
            """
        )

        # -------------------------------------------------------------------
        # Performance indexes for hot endpoints.
        # These are safe to run repeatedly because they use IF NOT EXISTS.
        # -------------------------------------------------------------------

        # Feed / social
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts (author_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments (post_id, created_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_story_likes_user ON story_likes (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_story_comments_story_created ON story_comments (story_id, created_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stories_user_expires ON stories (user_name, expires_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_bids_post_created ON bids (post_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_bids_user_created ON bids (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_follows_follower_followee ON follows (follower, followee)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee)")

        # Auctions / sales / lots / bids
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_auctions_status_ends ON auctions (status, ends_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_auctions_host_status ON auctions (host_username, status)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lots_sale_position ON lots (sale_id, position)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lots_sale_status ON lots (sale_id, status)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lot_bids_lot_amount ON lot_bids (lot_id, amount DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lot_bids_lot_created ON lot_bids (lot_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lot_bids_user_created ON lot_bids (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_created ON auction_bids (auction_id, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_auction_bids_user_created ON auction_bids (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_invitations_user ON invitations (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_name)")

        # Ledger / VIP
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ledger_acct_cur ON ledger_entries (user_name, currency, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_vip_status_renews ON vip_subscriptions (status, renews_at)")

        # Chat core
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_members_user_conv ON chat_members (user_name, conversation_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_members_conv_user ON chat_members (conversation_id, user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_deleted_id ON chat_messages (conversation_id, deleted_at, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_id_desc ON chat_messages (conversation_id, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reads_conv_user ON chat_reads (conversation_id, user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reads_user ON chat_reads (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_presence_user ON chat_presence (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_conversations_kind_join_updated ON chat_conversations (kind, join_mode, updated_at DESC)")

        # Groups / discovery / requests
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_user_status ON group_join_requests (group_id, user_name, status)")

        # Blocks / privacy
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocker_blocked ON chat_blocks (blocker, blocked)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked_blocker ON chat_blocks (blocked, blocker)")

        # Starred / reactions / hidden / prefs / drafts
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_starred_user_message ON chat_starred_messages (user_name, message_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reactions_message_user ON chat_reactions (message_id, user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_message_hidden_user_message ON chat_message_hidden (user_name, message_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_conversation_prefs_user ON chat_conversation_prefs (user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_drafts_user_conv ON chat_drafts (user_name, conversation_id)")

        # Chat notifications
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_user_created ON chat_notifications (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_unread ON chat_notifications (user_name, read_at, created_at DESC)")

        # Community calls
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_status_deadline ON community_calls (status, deadline_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_host ON community_calls (host_user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_kind ON community_calls (kind)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_scene ON community_calls (scene) WHERE scene IS NOT NULL")

        # Call interest / reminders
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_interest_call_user ON call_interest (call_id, user_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_interest_user_call ON call_interest (user_name, call_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_reminders_call_window ON call_reminders (call_id, window_days)")

        # Unified notifications
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_name, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_name, read_at, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_cat_type_created ON notifications (user_name, category, type, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications (source_type, source_id)")

        # Payment events / payout profile
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_payment_events_account ON payment_events (account, created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_house_payout_status ON house_payout_profiles (status)")

        conn.commit()

    except Exception:
        _rollback(conn)
        raise

    finally:
        _close(conn)


if __name__ == "__main__":
    init_db()
    print("db schema initialized")