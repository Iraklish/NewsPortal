import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .auth_deps import get_current_user
from .config import settings as app_settings
from .database import SessionLocal, init_db
from .logging_config import configure_logging
from .routers import analysis, articles, auth, logs, mindmap, search, settings, sources, stocks, telegram, twitter, whatsapp
from .services.background_scheduler import run_scheduler, run_auto_tag_scheduler, run_twitter_scheduler
from .services.security import hash_password

logger = logging.getLogger(__name__)


def _ensure_initial_admin() -> None:
    """Create the first admin account on a fresh install (no users yet).

    Username/password come from env (INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD)
    or config; if no password is provided, a strong random one is generated and
    logged ONCE so the operator can sign in and change it.
    """
    from .models import User
    db = SessionLocal()
    try:
        if db.query(User).count() > 0:
            return
        username = (
            os.getenv("INITIAL_ADMIN_USERNAME")
            or app_settings.initial_admin_username
            or "admin"
        ).strip()
        password = os.getenv("INITIAL_ADMIN_PASSWORD") or app_settings.initial_admin_password
        generated = False
        if not password:
            password = secrets.token_urlsafe(12)
            generated = True
        db.add(User(username=username, password_hash=hash_password(password), is_admin=True, is_active=True))
        db.commit()
        if generated:
            logger.warning("=" * 64)
            logger.warning("INITIAL ADMIN ACCOUNT CREATED")
            logger.warning("  username: %s", username)
            logger.warning("  password: %s", password)
            logger.warning("Sign in and change this password. It is shown only once.")
            logger.warning("=" * 64)
        else:
            logger.info("Initial admin account created (username=%s, password from env/config)", username)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Configure file logging with DB-overridable retention before anything else logs.
    db = SessionLocal()
    try:
        configure_logging(db)
    finally:
        db.close()

    _ensure_initial_admin()

    # Start the news-fetch scheduler as an asyncio background task.
    # It runs inside this process — no separate window or subprocess needed.
    scheduler_task = asyncio.create_task(run_scheduler())
    # Secondary scheduler: every 10 min, backfill tags for untagged articles.
    auto_tag_task = asyncio.create_task(run_auto_tag_scheduler())
    # Twitter auto-fetch (opt-in, interval from Settings; disabled by default).
    twitter_task = asyncio.create_task(run_twitter_scheduler())
    try:
        yield
    finally:
        # Cancel schedulers and wait for them to exit cleanly.
        scheduler_task.cancel()
        auto_tag_task.cancel()
        twitter_task.cancel()
        for task in (scheduler_task, auto_tag_task, twitter_task):
            try:
                await task
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

# Auth router is public (login lives here); its own routes guard themselves.
app.include_router(auth.router, prefix="/auth", tags=["auth"])

# Every other router requires a valid Bearer token.
_protected = [Depends(get_current_user)]
app.include_router(articles.router, prefix="/articles", tags=["articles"], dependencies=_protected)
app.include_router(analysis.router, prefix="/analysis", tags=["analysis"], dependencies=_protected)
app.include_router(settings.router, prefix="/settings", tags=["settings"], dependencies=_protected)
app.include_router(stocks.router, prefix="/stocks", tags=["stocks"], dependencies=_protected)
app.include_router(mindmap.router, prefix="/mindmap", tags=["mindmap"], dependencies=_protected)
app.include_router(sources.router, prefix="/sources", tags=["sources"], dependencies=_protected)
app.include_router(logs.router, prefix="/logs", tags=["logs"], dependencies=_protected)
app.include_router(telegram.router, prefix="/telegram", tags=["telegram"], dependencies=_protected)
app.include_router(whatsapp.router, prefix="/whatsapp", tags=["whatsapp"], dependencies=_protected)
app.include_router(twitter.router, prefix="/twitter", tags=["twitter"], dependencies=_protected)
app.include_router(search.router, prefix="/search", tags=["search"], dependencies=_protected)


# Serve downloaded media (e.g. Telegram post images) as static files. Public so
# <img> tags can load them without an Authorization header.
_MEDIA_ROOT = Path(__file__).resolve().parent.parent / "media"
_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(_MEDIA_ROOT)), name="media")


@app.get("/health")
async def health():
    """Public liveness probe — no data exposed, safe for monitoring."""
    return {"status": "ok"}
