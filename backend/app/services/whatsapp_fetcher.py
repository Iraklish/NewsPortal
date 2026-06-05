"""Fetch WhatsApp chat/group messages via the Node bridge and store as Articles.

The bridge (whatsapp-bridge/) runs the actual WhatsApp Web session and exposes a
localhost HTTP API. This module just polls it. See whatsapp-bridge/README.md.

Each message becomes an Article with a synthetic URL
``whatsapp://<chat_id>/<message_id>`` (sha-256 hashed for dedup), category
``whatsapp``.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Article, WhatsAppSource
from .dedup import url_hash

logger = logging.getLogger(__name__)


def _bridge_url() -> str:
    return (os.getenv("WHATSAPP_BRIDGE_URL") or settings.whatsapp_bridge_url or "http://127.0.0.1:8765").rstrip("/")


def _headers() -> dict:
    token = os.getenv("WHATSAPP_BRIDGE_TOKEN") or settings.whatsapp_bridge_token
    return {"x-bridge-token": token} if token else {}


async def _bridge_get(path: str, params: dict | None = None, timeout: float = 30.0) -> object:
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.get(f"{_bridge_url()}{path}", params=params or {}, headers=_headers())
        r.raise_for_status()
        return r.json()


async def bridge_status() -> dict:
    """Return the bridge/session status, or a safe 'unreachable' shape."""
    try:
        data = await _bridge_get("/status", timeout=10.0)
        return data if isinstance(data, dict) else {"ready": False, "authenticated": False}
    except Exception as exc:
        return {"ready": False, "authenticated": False, "qr": None, "error": f"bridge unreachable: {exc}"}


async def list_chats() -> list[dict]:
    data = await _bridge_get("/chats", timeout=30.0)
    return data if isinstance(data, list) else []


async def _bridge_post(path: str, timeout: float = 30.0) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(f"{_bridge_url()}{path}", headers=_headers())
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, dict) else {}


async def bridge_connect() -> dict:
    """Ask the bridge to start the WhatsApp session (emits a QR to scan)."""
    return await _bridge_post("/connect", timeout=20.0)


async def bridge_disconnect() -> dict:
    return await _bridge_post("/disconnect", timeout=20.0)


def _msg_url(chat_id: str, msg_id: str) -> str:
    return f"whatsapp://{chat_id}/{msg_id}"


async def fetch_whatsapp_source(source: WhatsAppSource, db: Session) -> list[int]:
    """Fetch recent messages for one chat/group. Returns inserted Article IDs."""
    new_ids: list[int] = []
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=source.lookback_hours)

    try:
        messages = await _bridge_get("/messages", params={"chatId": source.chat_id, "limit": 200})
    except Exception as exc:
        logger.warning("[whatsapp] fetch failed for %s: %s", source.name or source.chat_id, exc)
        source.last_status = "error"
        source.last_error = str(exc)[:512]
        _commit(db)
        return []

    if not isinstance(messages, list):
        messages = []

    for m in messages:
        ts = m.get("timestamp")
        if not ts:
            continue
        msg_time = datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None)
        if msg_time < cutoff:
            continue

        body = (m.get("body") or "").strip()
        has_media = bool(m.get("hasMedia"))
        if not body and not has_media:
            continue

        msg_id = str(m.get("id") or "")
        if not msg_id:
            continue
        u = _msg_url(source.chat_id, msg_id)
        u_hash = url_hash(u)
        if db.query(Article).filter(Article.url_hash == u_hash).first():
            continue   # already stored

        first_line = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")[:200]
        title = first_line or ("Media message" if has_media else None)
        author = m.get("authorName") or None
        source_label = source.name or source.chat_id
        if author and source.is_group:
            source_label = f"{source.name or source.chat_id} · {author}"

        article = Article(
            url=u,
            url_hash=u_hash,
            title=title,
            source=source_label,
            author=author,
            category="whatsapp",
            published_at=msg_time,
            content=body,
            is_analyzed=False,
        )
        db.add(article)
        try:
            db.flush()
            new_ids.append(article.id)
        except Exception:
            db.rollback()
            logger.warning("[whatsapp] failed to store msg %s/%s", source.chat_id, msg_id)

    source.last_fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    source.last_status = "ok" if new_ids else "empty"
    source.last_error = None
    _commit(db)
    return new_ids


async def fetch_all_whatsapp_sources(db: Session) -> list[int]:
    """Fetch all enabled WhatsApp sources. Safe no-op when the bridge is down."""
    sources = db.query(WhatsAppSource).filter(WhatsAppSource.enabled == True).all()  # noqa: E712
    if not sources:
        return []
    status = await bridge_status()
    if not status.get("ready"):
        logger.debug("[whatsapp] bridge not ready — skipping fetch")
        return []
    all_ids: list[int] = []
    for src in sources:
        try:
            all_ids.extend(await fetch_whatsapp_source(src, db))
        except Exception as exc:
            logger.warning("[whatsapp] source %s failed: %s", src.chat_id, exc)
    if all_ids:
        logger.info("[whatsapp] fetched %d new message(s) from %d chat(s)", len(all_ids), len(sources))
    return all_ids


def _commit(db: Session) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
