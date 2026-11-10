import asyncio
import os
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routers import (
    feed,
    auctions,
    sales,
    profile,
    chat,
    chat_features,
    settings,
    notifications,
    community,
    webhooks,
    admin
)
import notification_service
from routers.community import sweep_call_deadlines

from db import init_db

SWEEP_INTERVAL_SECONDS = 900  # 15 min; day-granular reminders don't need more


async def _sweep_loop():
    # Sleep first so we never touch the DB during boot before init_db has run.
    # to_thread keeps the blocking psycopg2 call off the event loop.
    while True:
        try:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            await asyncio.to_thread(sweep_call_deadlines)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a Neon blip skips one cycle, never kills boot
            print(f"[calls-sweep] cycle failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_db()
    except Exception as exc:
        # Print the REAL traceback so the next log names the exact db.py line
        # instead of the vague "cursor already closed".
        print(f"[startup] database init failed: {exc!r}")
        traceback.print_exc()

    task = asyncio.create_task(_sweep_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)

# Read ALLOWED_ORIGINS from the environment, exactly like auth_server.py.
# A hardcoded list here would silently ignore the feed dashboard's env var and
# re-trigger the CORS preflight block the moment the live site calls /feed.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

if not ALLOWED_ORIGINS:
    ALLOWED_ORIGINS = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,   # feed uses viewer-param / token-in-body, not cookies.
    allow_methods=["*"],       # If you ever send cookies, flip to True AND keep
    allow_headers=["*"],       # explicit origins — never ["*"] with credentials.
)

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

app.include_router(feed.router)
app.include_router(sales.router)
app.include_router(profile.router)
app.include_router(chat.router)
app.include_router(chat_features.router)
app.include_router(auctions.router)
app.include_router(settings.router)
app.include_router(notifications.router)
app.include_router(community.router)
app.include_router(webhooks.router)
app.include_router(notification_service.router)
app.include_router(admin.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)