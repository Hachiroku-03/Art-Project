from pathlib import Path

p = Path("db.py")

if not p.exists():
    raise SystemExit("Run this from the backend folder that contains db.py")

src = p.read_text(encoding="utf-8")

# Idempotent guard: never patch twice.
if "_init_pool" in src:
    print("db.py already patched. Nothing to do.")
    raise SystemExit(0)

marker = "def init_db():"
idx = src.find(marker)

if idx == -1:
    raise SystemExit("Could not find 'def init_db():' in db.py. Aborting.")

# Keep your entire existing init_db() exactly as-is.
tail = src[idx:]

HEADER = '''# --- connection pooling added by patch_db.py ---
import os
import threading
import time

import psycopg2
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


def _init_pool():
    global _pool

    if _pool is not None:
        return

    with _pool_lock:
        if _pool is not None:
            return

        minconn = int(os.getenv("DB_POOL_MIN", "2"))
        maxconn = int(os.getenv("DB_POOL_MAX", "10"))

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
    # Drop-in wrapper. Existing code can keep doing:
    #   conn = get_db()
    #   cursor = conn.cursor()
    #   conn.commit()
    #   conn.rollback()
    #   conn.close()
    # but close() returns the connection to the pool instead of destroying it.

    __slots__ = ("_conn", "_pool", "_closed")

    def __init__(self, conn, p):
        self._conn = conn
        self._pool = p
        self._closed = False

    def cursor(self, *args, **kwargs):
        if self._closed:
            raise RuntimeError("Cannot use a pooled connection after close()")
        return self._conn.cursor(*args, **kwargs)

    def commit(self):
        if self._closed:
            raise RuntimeError("Cannot commit a pooled connection after close()")
        return self._conn.commit()

    def rollback(self):
        if self._closed:
            return
        try:
            self._conn.rollback()
        except Exception:
            pass

    def close(self):
        if self._closed:
            return

        self._closed = True

        # If the caller left a transaction open, roll it back before
        # returning the connection to the pool.
        try:
            self._conn.rollback()
        except Exception:
            pass

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
        self.close()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def get_db(timeout=10.0):
    # Get a pooled DB connection. If the pool is temporarily exhausted,
    # wait briefly instead of failing immediately. This helps during
    # community-page request fan-out.
    _init_pool()

    deadline = time.monotonic() + float(timeout)

    while True:
        try:
            return PooledConnection(_pool.getconn(), _pool)
        except pool.PoolError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def warm_pool(n=3):
    # Optional: pre-open a few connections at startup so the first
    # requests do not pay the cold-connect cost.
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
    # Optional: clean teardown on shutdown.
    global _pool

    with _pool_lock:
        if _pool is None:
            return

        try:
            _pool.closeall()
        except Exception:
            pass

        _pool = None


'''

backup = Path("db.py.bak")
backup.write_text(src, encoding="utf-8")

p.write_text(HEADER + tail, encoding="utf-8")

print("Patched db.py with connection pooling.")
print("Backup saved as db.py.bak")