import os
import time

from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor

# Try backend/.env first, then project root .env
if not load_dotenv(".env"):
    load_dotenv("../.env")

url = os.getenv("DATABASE_URL")

if not url:
    raise SystemExit("DATABASE_URL missing. Check .env or ../.env")

print("DATABASE_URL found:", True)

for i in range(3):
    t = time.perf_counter()

    conn = psycopg2.connect(
        url,
        cursor_factory=RealDictCursor,
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )

    cur = conn.cursor()
    cur.execute("SELECT 1")
    cur.fetchone()

    ms = round((time.perf_counter() - t) * 1000)
    print(f"connect + SELECT 1: {ms} ms")

    conn.close()
