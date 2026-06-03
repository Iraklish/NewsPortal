"""Telegram sources management + authentication endpoints."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from sqlalchemy import text

from ..database import get_db
from ..models import TelegramSource
from ..schemas import TelegramSourceCreate, TelegramSourceOut, TelegramSourceUpdate

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Auth endpoints ────────────────────────────────────────────────────────────

class RequestCodeIn(BaseModel):
    phone: str


class UnreadChannel(BaseModel):
    channel_id: str
    name: str
    unread_count: int
    is_group: bool
    is_channel: bool
    already_added: bool


class SignInIn(BaseModel):
    code: str
    password: str = ""   # only needed if 2FA is enabled


@router.get("/auth/status")
async def auth_status(db: Session = Depends(get_db)):
    """Check whether the stored Telegram session is authorised."""
    from ..services.telegram_fetcher import check_authorized, credentials_configured
    if not credentials_configured(db):
        return {"authorized": False, "reason": "credentials_not_configured"}
    try:
        ok = await check_authorized(db)
        return {"authorized": ok}
    except Exception as exc:
        return {"authorized": False, "reason": str(exc)}


@router.post("/auth/request-code")
async def request_code(body: RequestCodeIn, db: Session = Depends(get_db)):
    """Send a login code to the configured Telegram phone number."""
    from ..services.telegram_fetcher import request_code as _request_code, credentials_configured
    if not credentials_configured(db):
        raise HTTPException(status_code=400, detail="Set telegram_api_id and telegram_api_hash in Settings first")
    try:
        await _request_code(body.phone, db)
        return {"sent": True, "phone": body.phone}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/auth/sign-in")
async def sign_in(body: SignInIn, db: Session = Depends(get_db)):
    """Complete Telegram sign-in with the received code."""
    from ..services.telegram_fetcher import sign_in as _sign_in
    try:
        ok = await _sign_in(body.code, db, password=body.password)
        return {"authorized": ok}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Unread discovery ─────────────────────────────────────────────────────────

@router.get("/unread", response_model=List[UnreadChannel])
async def list_unread(db: Session = Depends(get_db)):
    """Return all Telegram dialogs (groups/channels/bots) with unread messages."""
    from ..services.telegram_fetcher import (
        credentials_configured, check_authorized, list_unread_channels,
    )
    if not credentials_configured(db):
        raise HTTPException(status_code=400, detail="Telegram credentials not configured")
    try:
        if not await check_authorized(db):
            raise HTTPException(status_code=401, detail="Not authorised — please sign in first")
        channels = await list_unread_channels(db)
        return channels
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[telegram] unread listing failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Source CRUD ───────────────────────────────────────────────────────────────

def _message_counts(db: Session) -> dict[str, int]:
    """Count stored messages per channel.

    Telegram messages are stored as Article rows with a synthetic URL of the
    form ``telegram://<channel_id>/<msg_id>``. We extract <channel_id> (the text
    after the 11-char 'telegram://' prefix, up to the next '/') and group-count.
    """
    rows = db.execute(text(
        "SELECT substr(url, 12, instr(substr(url, 12), '/') - 1) AS chan, COUNT(*) AS c "
        "FROM articles WHERE url LIKE 'telegram://%' GROUP BY chan"
    )).all()
    return {r[0]: r[1] for r in rows if r[0]}


@router.get("", response_model=List[TelegramSourceOut])
def list_sources(db: Session = Depends(get_db)):
    sources = db.query(TelegramSource).order_by(TelegramSource.id).all()
    counts = _message_counts(db)
    out: List[TelegramSourceOut] = []
    for s in sources:
        item = TelegramSourceOut.model_validate(s)
        item.message_count = counts.get(s.channel_id, 0)
        out.append(item)
    return out


@router.post("", response_model=TelegramSourceOut, status_code=201)
def create_source(body: TelegramSourceCreate, db: Session = Depends(get_db)):
    channel_id = str(body.channel_id).strip()
    if db.query(TelegramSource).filter(TelegramSource.channel_id == channel_id).first():
        raise HTTPException(status_code=409, detail="Channel already exists")
    src = TelegramSource(
        channel_id=channel_id,
        name=(body.name or "").strip() or None,
        enabled=body.enabled,
        lookback_hours=max(1, body.lookback_hours),
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return src


@router.put("/{source_id}", response_model=TelegramSourceOut)
def update_source(source_id: int, body: TelegramSourceUpdate, db: Session = Depends(get_db)):
    src = db.query(TelegramSource).filter(TelegramSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    data = body.model_dump(exclude_none=True)
    for field in ("channel_id", "name", "enabled", "lookback_hours"):
        if field in data:
            val = data[field]
            if field == "channel_id":
                val = str(val).strip()
            if field == "lookback_hours":
                val = max(1, int(val))
            setattr(src, field, val)
    db.commit()
    db.refresh(src)
    item = TelegramSourceOut.model_validate(src)
    item.message_count = _message_counts(db).get(src.channel_id, 0)
    return item


@router.delete("/{source_id}")
def delete_source(source_id: int, db: Session = Depends(get_db)):
    src = db.query(TelegramSource).filter(TelegramSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    db.delete(src)
    db.commit()
    return {"deleted": True, "id": source_id}


# ── Manual fetch ──────────────────────────────────────────────────────────────

class FetchResult(BaseModel):
    sources_fetched: int
    new_articles: int


@router.post("/fetch", response_model=FetchResult)
async def manual_fetch(db: Session = Depends(get_db)):
    """Manually trigger a fetch cycle for all enabled Telegram sources."""
    from ..services.telegram_fetcher import fetch_all_telegram_sources
    try:
        ids = await fetch_all_telegram_sources(db)
        return FetchResult(
            sources_fetched=db.query(TelegramSource).filter(TelegramSource.enabled == True).count(),
            new_articles=len(ids),
        )
    except Exception as exc:
        logger.exception("[telegram] manual fetch failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{source_id}/fetch")
async def fetch_one(source_id: int, db: Session = Depends(get_db)):
    """Trigger fetch for a single Telegram source."""
    from ..services.telegram_fetcher import fetch_telegram_channel, _cred, credentials_configured
    src = db.query(TelegramSource).filter(TelegramSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    if not credentials_configured(db):
        raise HTTPException(status_code=400, detail="Telegram credentials not configured")
    try:
        api_id = int(_cred(db, "telegram_api_id"))
        api_hash = _cred(db, "telegram_api_hash")
        ids = await fetch_telegram_channel(src, db, api_id, api_hash)
        return {"new_articles": len(ids), "ids": ids}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
