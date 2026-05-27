"""Fetch messages from Telegram channels and store them as Article records.

Authentication
──────────────
On first use, call ``request_code(phone, db)`` then ``sign_in(phone, code, db)``
via the /telegram/auth/* API endpoints.  The session is saved to
``backend/telegram_session.session`` and reused on every subsequent call.

Scheduling
──────────
``fetch_all_telegram_sources(db)`` is called by ``scheduler_process.py`` as
part of the regular fetch cycle.  Only enabled TelegramSource rows are fetched.

Deduplication
─────────────
Each message gets a synthetic URL  ``telegram://<channel_id>/<message_id>`` and
its sha-256 hash is checked against Article.url_hash before inserting.
Messages that already exist are silently skipped.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..models import AppSettings, Article, TelegramSource
from .dedup import url_hash

logger = logging.getLogger(__name__)

# Session file lives next to backend/economic_review.db for persistence.
_SESSION_PATH = str(Path(__file__).resolve().parent.parent.parent / "telegram_session")

# Per-process asyncio lock — prevents concurrent access to the SQLite session file.
_lock: Optional[asyncio.Lock] = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


# ── Credentials helpers ───────────────────────────────────────────────────────

def _cred(db: Session, key: str) -> str:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    return (row.value or "").strip() if row else ""


def _set_cred(db: Session, key: str, value: str) -> None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSettings(key=key, value=value))


def credentials_configured(db: Session) -> bool:
    return bool(_cred(db, "telegram_api_id") and _cred(db, "telegram_api_hash"))


# ── Auth helpers (called from the router) ────────────────────────────────────

async def request_code(phone: str, db: Session) -> str:
    """Send a login code to `phone`.  Returns the phone_code_hash needed for sign_in."""
    from telethon import TelegramClient
    api_id = int(_cred(db, "telegram_api_id"))
    api_hash = _cred(db, "telegram_api_hash")
    async with _get_lock():
        client = TelegramClient(_SESSION_PATH, api_id, api_hash)
        await client.connect()
        try:
            result = await client.send_code_request(phone)
            phone_code_hash = result.phone_code_hash
            # Persist hash so sign_in can retrieve it
            _set_cred(db, "_tg_phone_code_hash", phone_code_hash)
            _set_cred(db, "_tg_pending_phone", phone)
            db.commit()
            return phone_code_hash
        finally:
            await client.disconnect()


async def sign_in(code: str, db: Session, password: str = "") -> bool:
    """Complete sign-in with the code from Telegram.
    If account uses 2FA, pass `password` too.  Returns True on success.
    """
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError
    api_id = int(_cred(db, "telegram_api_id"))
    api_hash = _cred(db, "telegram_api_hash")
    phone = _cred(db, "_tg_pending_phone")
    phone_code_hash = _cred(db, "_tg_phone_code_hash")
    async with _get_lock():
        client = TelegramClient(_SESSION_PATH, api_id, api_hash)
        await client.connect()
        try:
            try:
                await client.sign_in(phone, code, phone_code_hash=phone_code_hash)
            except SessionPasswordNeededError:
                if not password:
                    raise ValueError("2FA password required")
                await client.sign_in(password=password)
            # Clean up temp keys
            for k in ("_tg_phone_code_hash", "_tg_pending_phone"):
                row = db.query(AppSettings).filter(AppSettings.key == k).first()
                if row:
                    db.delete(row)
            db.commit()
            return True
        finally:
            await client.disconnect()


async def check_authorized(db: Session) -> bool:
    """Return True if a valid session exists."""
    if not credentials_configured(db):
        return False
    from telethon import TelegramClient
    api_id = int(_cred(db, "telegram_api_id"))
    api_hash = _cred(db, "telegram_api_hash")
    async with _get_lock():
        client = TelegramClient(_SESSION_PATH, api_id, api_hash)
        await client.connect()
        try:
            return await client.is_user_authorized()
        finally:
            await client.disconnect()


# ── Per-channel fetch ─────────────────────────────────────────────────────────

def _msg_url(channel_id: str, msg_id: int) -> str:
    return f"telegram://{channel_id}/{msg_id}"


async def fetch_telegram_channel(
    source: TelegramSource,
    db: Session,
    api_id: int,
    api_hash: str,
) -> list[int]:
    """Fetch new messages from one channel.  Returns list of inserted Article IDs."""
    from telethon import TelegramClient
    from telethon.tl.functions.messages import GetHistoryRequest

    new_ids: list[int] = []
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=source.lookback_hours)

    async with _get_lock():
        client = TelegramClient(_SESSION_PATH, api_id, api_hash)
        await client.connect()
        try:
            if not await client.is_user_authorized():
                logger.warning("[telegram] session not authorized — skipping %s", source.name)
                return []

            # Accept int channel IDs or string usernames
            try:
                peer_key = int(source.channel_id)
            except (ValueError, TypeError):
                peer_key = source.channel_id

            entity = await client.get_entity(peer_key)
            offset_id = 0

            while True:
                result = await client(GetHistoryRequest(
                    peer=entity,
                    limit=200,
                    offset_date=None,
                    offset_id=offset_id,
                    max_id=0,
                    min_id=0,
                    add_offset=0,
                    hash=0,
                ))
                if not result.messages:
                    break

                reached_cutoff = False
                for msg in result.messages:
                    msg_time = msg.date.replace(tzinfo=None)
                    if msg_time < cutoff:
                        reached_cutoff = True
                        break

                    text = (getattr(msg, "message", "") or "").strip()
                    if not text:
                        continue

                    u = _msg_url(source.channel_id, msg.id)
                    u_hash = url_hash(u)
                    if db.query(Article).filter(Article.url_hash == u_hash).first():
                        continue   # already stored

                    # First non-empty line → title (≤200 chars)
                    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")[:200]

                    article = Article(
                        url=u,
                        url_hash=u_hash,
                        title=first_line or None,
                        source=source.name or source.channel_id,
                        category="telegram",
                        published_at=msg_time,
                        content=text,
                        is_analyzed=False,
                    )
                    db.add(article)
                    try:
                        db.flush()   # get the id without committing yet
                        new_ids.append(article.id)
                    except Exception:
                        db.rollback()
                        logger.warning("[telegram] failed to store msg %s/%d", source.channel_id, msg.id)

                try:
                    db.commit()
                except Exception:
                    db.rollback()

                if reached_cutoff or not result.messages:
                    break
                if result.messages[-1].date.replace(tzinfo=None) < cutoff:
                    break
                offset_id = result.messages[-1].id

        except Exception as exc:
            logger.exception("[telegram] error fetching channel %s: %s", source.channel_id, exc)
            source.last_status = "error"
            source.last_error = str(exc)[:512]
            try:
                db.commit()
            except Exception:
                db.rollback()
            return new_ids
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass

    source.last_fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    source.last_status = "ok" if new_ids else "empty"
    source.last_error = None
    try:
        db.commit()
    except Exception:
        db.rollback()

    return new_ids


# ── Unread channel discovery ────────────────────────────────────────────────

async def list_unread_channels(db: Session) -> list[dict]:
    """Return all dialogs (groups / channels / bots) that have unread messages.

    Each item: channel_id (str), name, unread_count, is_group, is_channel,
    already_added (True if the channel_id is already a TelegramSource row).
    """
    if not credentials_configured(db):
        return []
    from telethon import TelegramClient

    api_id = int(_cred(db, "telegram_api_id"))
    api_hash = _cred(db, "telegram_api_hash")

    # Pre-load existing channel_ids for the 'already_added' flag
    existing_ids: set[str] = {src.channel_id for src in db.query(TelegramSource).all()}

    results: list[dict] = []

    async with _get_lock():
        client = TelegramClient(_SESSION_PATH, api_id, api_hash)
        await client.connect()
        try:
            if not await client.is_user_authorized():
                logger.warning("[telegram] list_unread: session not authorized")
                return []
            async for dialog in client.iter_dialogs():
                is_bot = hasattr(dialog.entity, "bot") and bool(dialog.entity.bot)
                if not (dialog.is_group or dialog.is_channel or is_bot):
                    continue
                if dialog.unread_count <= 0:
                    continue
                channel_id_str = str(dialog.id)
                results.append({
                    "channel_id": channel_id_str,
                    "name": dialog.name or "",
                    "unread_count": dialog.unread_count,
                    "is_group": bool(dialog.is_group),
                    "is_channel": bool(dialog.is_channel),
                    "already_added": channel_id_str in existing_ids,
                })
            logger.info("[telegram] list_unread: found %d dialog(s) with unread messages", len(results))
        except Exception as exc:
            logger.exception("[telegram] list_unread error: %s", exc)
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass

    return results


# ── Scheduler entry point ────────────────────────────────────────────────────

async def fetch_all_telegram_sources(db: Session) -> list[int]:
    """Fetch all enabled Telegram sources.  Returns list of new Article IDs."""
    if not credentials_configured(db):
        logger.debug("[telegram] credentials not configured — skipping")
        return []

    sources = db.query(TelegramSource).filter(TelegramSource.enabled == True).all()
    if not sources:
        return []

    api_id_str = _cred(db, "telegram_api_id")
    api_hash = _cred(db, "telegram_api_hash")
    try:
        api_id = int(api_id_str)
    except (ValueError, TypeError):
        logger.warning("[telegram] invalid telegram_api_id: %r", api_id_str)
        return []

    all_ids: list[int] = []
    for source in sources:
        try:
            ids = await fetch_telegram_channel(source, db, api_id, api_hash)
            if ids:
                logger.info("[telegram] %s: +%d new message(s)", source.name or source.channel_id, len(ids))
            all_ids.extend(ids)
        except Exception as exc:
            logger.exception("[telegram] unhandled error for %s: %s", source.channel_id, exc)

    return all_ids
