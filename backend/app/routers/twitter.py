"""Twitter/X source management + login (via twikit, unofficial)."""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import TwitterSource
from ..schemas import (
    TwitterLoginRequest,
    TwitterSourceCreate,
    TwitterSourceOut,
    TwitterSourceUpdate,
)

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Auth ──────────────────────────────────────────────────────────────────────

@router.get("/auth/status")
async def auth_status():
    from ..services.twitter_fetcher import check_auth
    return await check_auth()


@router.post("/auth/login")
async def auth_login(body: TwitterLoginRequest):
    """Log in to X with credentials (used once; only session cookies are saved)."""
    from ..services.twitter_fetcher import login
    if not body.username.strip() or not body.password:
        raise HTTPException(status_code=400, detail="username and password are required")
    totp = (body.totp_secret or "").strip()
    if totp and totp.isdigit():
        raise HTTPException(
            status_code=400,
            detail="The 2FA field needs your authenticator SECRET KEY (a long base32 string), not the rotating 6-digit code. Leave it blank if you don't use an authenticator app.",
        )
    try:
        await login(body.username.strip(), (body.email or "").strip() or None, body.password, (body.totp_secret or "").strip() or None)
        return {"authenticated": True}
    except Exception as exc:
        logger.warning("[twitter] login failed: %s", exc)
        raise HTTPException(status_code=400, detail=f"Login failed: {exc}")


class CookieLoginRequest(BaseModel):
    auth_token: str
    ct0: str


@router.post("/auth/cookies")
async def auth_cookies(body: CookieLoginRequest):
    """Authenticate with browser cookies (auth_token + ct0) — avoids the
    Cloudflare-blocked login flow."""
    from ..services.twitter_fetcher import login_with_cookies, verify_session
    try:
        await login_with_cookies(body.auth_token, body.ct0)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not set cookies: {exc}")
    # Cookies are saved. Try a live read to confirm; if it fails we keep the
    # cookies anyway (X anti-bot may block the probe even with valid cookies) and
    # return the real error as a warning so the user can decide.
    v = await verify_session()
    if v.get("ok"):
        return {"authenticated": True, "verified": True}
    return {"authenticated": True, "verified": False, "warning": (v.get("error") or "Could not verify the session with X")[:250]}


@router.post("/auth/logout")
async def auth_logout():
    from ..services.twitter_fetcher import logout
    logout()
    return {"authenticated": False}


# ── Source CRUD ───────────────────────────────────────────────────────────────

def _message_counts(db: Session) -> dict[str, int]:
    """Count stored tweets per source by author from the article URL.

    Tweet URLs look like https://x.com/<author>/status/<id>; we group by author.
    """
    rows = db.execute(text(
        "SELECT lower(substr(url, 15, instr(substr(url, 15), '/status/') - 1)) AS author, COUNT(*) AS c "
        "FROM articles WHERE url LIKE 'https://x.com/%/status/%' GROUP BY author"
    )).all()
    return {r[0]: r[1] for r in rows if r[0]}


@router.get("", response_model=List[TwitterSourceOut])
def list_sources(db: Session = Depends(get_db)):
    sources = db.query(TwitterSource).order_by(TwitterSource.id).all()
    counts = _message_counts(db)
    out: List[TwitterSourceOut] = []
    for s in sources:
        item = TwitterSourceOut.model_validate(s)
        if s.kind == "user":
            item.message_count = counts.get(s.handle.lstrip("@").lower(), 0)
        out.append(item)
    return out


@router.post("", response_model=TwitterSourceOut, status_code=201)
def create_source(body: TwitterSourceCreate, db: Session = Depends(get_db)):
    handle = str(body.handle).strip().lstrip("@") if body.kind == "user" else str(body.handle).strip()
    if not handle:
        raise HTTPException(status_code=400, detail="handle is required")
    kind = body.kind if body.kind in ("user", "list", "search") else "user"
    if db.query(TwitterSource).filter(TwitterSource.handle == handle, TwitterSource.kind == kind).first():
        raise HTTPException(status_code=409, detail="Source already exists")
    src = TwitterSource(
        handle=handle,
        kind=kind,
        name=(body.name or "").strip() or None,
        enabled=body.enabled,
        lookback_hours=max(1, body.lookback_hours),
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return src


@router.put("/{source_id}", response_model=TwitterSourceOut)
def update_source(source_id: int, body: TwitterSourceUpdate, db: Session = Depends(get_db)):
    src = db.query(TwitterSource).filter(TwitterSource.id == source_id).first()
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
    item = TwitterSourceOut.model_validate(src)
    if src.kind == "user":
        item.message_count = _message_counts(db).get(src.handle.lstrip("@").lower(), 0)
    return item


@router.delete("/{source_id}")
def delete_source(source_id: int, db: Session = Depends(get_db)):
    src = db.query(TwitterSource).filter(TwitterSource.id == source_id).first()
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
    from ..services.twitter_fetcher import fetch_all_twitter_sources
    try:
        ids = await fetch_all_twitter_sources(db)
        return FetchResult(
            sources_fetched=db.query(TwitterSource).filter(TwitterSource.enabled == True).count(),  # noqa: E712
            new_articles=len(ids),
        )
    except Exception as exc:
        logger.exception("[twitter] manual fetch failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{source_id}/fetch")
async def fetch_one(source_id: int, db: Session = Depends(get_db)):
    from ..services.twitter_fetcher import fetch_twitter_source
    src = db.query(TwitterSource).filter(TwitterSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    try:
        ids = await fetch_twitter_source(src, db)
        return {"new_articles": len(ids), "ids": ids}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
