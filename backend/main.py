import asyncio
import os
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
        print(f"[startup] database init failed: {exc}")

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
app.include_router(notification_service.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)