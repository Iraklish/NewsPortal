import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import SessionLocal, init_db
from .logging_config import configure_logging
from .routers import analysis, articles, logs, mindmap, search, settings, sources, stocks, telegram
from .services.background_scheduler import run_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Configure file logging with DB-overridable retention before anything else logs.
    db = SessionLocal()
    try:
        configure_logging(db)
    finally:
        db.close()

    # Start the news-fetch scheduler as an asyncio background task.
    # It runs inside this process — no separate window or subprocess needed.
    scheduler_task = asyncio.create_task(run_scheduler())
    try:
        yield
    finally:
        # Cancel the scheduler and wait for it to exit cleanly.
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="NewsPortal API", version="1.0.0", lifespan=lifespan)

# CORS: by default, accept any origin so remote users on the LAN (or anywhere the
# server is reachable) can talk to the API. Override by setting CORS_ORIGINS to a
# comma-separated list, e.g. "https://news.example.com,http://10.0.0.5:3000".
# Note: allow_credentials must be False when allow_origins is "*"; we use a regex
# match instead so both work — broad reach without losing credential support.
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
if _cors_env:
    _origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=".*",  # any origin, but reflected (so credentials still work)
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(articles.router, prefix="/articles", tags=["articles"])
app.include_router(analysis.router, prefix="/analysis", tags=["analysis"])
app.include_router(settings.router, prefix="/settings", tags=["settings"])
app.include_router(stocks.router, prefix="/stocks", tags=["stocks"])
app.include_router(mindmap.router, prefix="/mindmap", tags=["mindmap"])
app.include_router(sources.router, prefix="/sources", tags=["sources"])
app.include_router(logs.router, prefix="/logs", tags=["logs"])
app.include_router(telegram.router, prefix="/telegram", tags=["telegram"])
app.include_router(search.router, prefix="/search", tags=["search"])


@app.get("/health")
async def health():
    return {"status": "ok"}
