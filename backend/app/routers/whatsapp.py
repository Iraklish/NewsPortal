"""WhatsApp source management + auth/discovery, backed by the Node bridge."""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import WhatsAppSource
from ..schemas import WhatsAppSourceCreate, WhatsAppSourceOut, WhatsAppSourceUpdate

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Bridge auth / discovery ───────────────────────────────────────────────────

@router.get("/auth/status")
async def auth_status():
    """Return the bridge session status (ready/authenticated/connecting + QR)."""
    from ..services.whatsapp_fetcher import bridge_status
    return await bridge_status()


@router.post("/auth/connect")
async def auth_connect():
    """Start the WhatsApp session on the bridge (emits a QR to scan). Manual."""
    from ..services.whatsapp_fetcher import bridge_connect
    try:
        return await bridge_connect()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Bridge unreachable: {exc}")


@router.post("/auth/disconnect")
async def auth_disconnect():
    """Tear down the WhatsApp session on the bridge."""
    from ..services.whatsapp_fetcher import bridge_disconnect
    try:
        return await bridge_disconnect()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Bridge unreachable: {exc}")


class WAChat(BaseModel):
    id: str
    name: str | None = None
    isGroup: bool = False
    unreadCount: int = 0
    timestamp: int | None = None
    already_added: bool = False


@router.get("/chats", response_model=List[WAChat])
async def list_chats(db: Session = Depends(get_db)):
    """List the WhatsApp chats/groups available to add as sources."""
    from ..services.whatsapp_fetcher import bridge_status, list_chats as _list_chats
    status = await bridge_status()
    if not status.get("ready"):
        raise HTTPException(status_code=409, detail="WhatsApp bridge not ready — scan the QR first")
    try:
        chats = await _list_chats()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Bridge error: {exc}")
    existing = {s.chat_id for s in db.query(WhatsAppSource).all()}
    return [
        WAChat(
            id=c.get("id"), name=c.get("name"), isGroup=bool(c.get("isGroup")),
            unreadCount=c.get("unreadCount") or 0, timestamp=c.get("timestamp"),
            already_added=c.get("id") in existing,
        )
        for c in chats if c.get("id")
    ]


# ── Source CRUD ───────────────────────────────────────────────────────────────

def _message_counts(db: Session) -> dict[str, int]:
    rows = db.execute(text(
        "SELECT substr(url, 12, instr(substr(url, 12), '/') - 1) AS chat, COUNT(*) AS c "
        "FROM articles WHERE url LIKE 'whatsapp://%' GROUP BY chat"
    )).all()
    return {r[0]: r[1] for r in rows if r[0]}


@router.get("", response_model=List[WhatsAppSourceOut])
def list_sources(db: Session = Depends(get_db)):
    sources = db.query(WhatsAppSource).order_by(WhatsAppSource.id).all()
    counts = _message_counts(db)
    out: List[WhatsAppSourceOut] = []
    for s in sources:
        item = WhatsAppSourceOut.model_validate(s)
        item.message_count = counts.get(s.chat_id, 0)
        out.append(item)
    return out


@router.post("", response_model=WhatsAppSourceOut, status_code=201)
def create_source(body: WhatsAppSourceCreate, db: Session = Depends(get_db)):
    chat_id = str(body.chat_id).strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="chat_id is required")
    if db.query(WhatsAppSource).filter(WhatsAppSource.chat_id == chat_id).first():
        raise HTTPException(status_code=409, detail="Chat already added")
    src = WhatsAppSource(
        chat_id=chat_id,
        name=(body.name or "").strip() or None,
        is_group=bool(body.is_group),
        enabled=body.enabled,
        lookback_hours=max(1, body.lookback_hours),
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return src


@router.put("/{source_id}", response_model=WhatsAppSourceOut)
def update_source(source_id: int, body: WhatsAppSourceUpdate, db: Session = Depends(get_db)):
    src = db.query(WhatsAppSource).filter(WhatsAppSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    data = body.model_dump(exclude_none=True)
    if "name" in data:
        src.name = (data["name"] or "").strip() or None
    if "enabled" in data:
        src.enabled = bool(data["enabled"])
    if "lookback_hours" in data:
        src.lookback_hours = max(1, int(data["lookback_hours"]))
    db.commit()
    item = WhatsAppSourceOut.model_validate(src)
    item.message_count = _message_counts(db).get(src.chat_id, 0)
    return item


@router.delete("/{source_id}")
def delete_source(source_id: int, db: Session = Depends(get_db)):
    src = db.query(WhatsAppSource).filter(WhatsAppSource.id == source_id).first()
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
    from ..services.whatsapp_fetcher import fetch_all_whatsapp_sources
    try:
        ids = await fetch_all_whatsapp_sources(db)
        return FetchResult(
            sources_fetched=db.query(WhatsAppSource).filter(WhatsAppSource.enabled == True).count(),  # noqa: E712
            new_articles=len(ids),
        )
    except Exception as exc:
        logger.exception("[whatsapp] manual fetch failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{source_id}/fetch")
async def fetch_one(source_id: int, db: Session = Depends(get_db)):
    from ..services.whatsapp_fetcher import fetch_whatsapp_source
    src = db.query(WhatsAppSource).filter(WhatsAppSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    try:
        ids = await fetch_whatsapp_source(src, db)
        return {"new_articles": len(ids), "ids": ids}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
