"""Manage RSS sources stored in the rss_sources table."""
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings as app_settings
from ..database import get_db
from ..models import AppSettings, RssSource
from ..schemas import RssSourceCreate, RssSourceOut, RssSourceUpdate
from ..services.rss_sources import RSS_FEEDS

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/status")
def sources_status(db: Session = Depends(get_db)):
    """Aggregate status: counts + most recent fetch + next scheduled fetch."""
    from datetime import timedelta

    all_sources = db.query(RssSource).all()
    enabled = [s for s in all_sources if s.enabled]

    # Most recent fetch time from individual feed records
    last_fetch_at = None
    for s in enabled:
        if s.last_fetched_at and (last_fetch_at is None or s.last_fetched_at > last_fetch_at):
            last_fetch_at = s.last_fetched_at

    # Interval — read from DB so Settings UI changes are reflected immediately
    def _db_val(key: str) -> str | None:
        row = db.query(AppSettings).filter(AppSettings.key == key).first()
        return row.value if row else None

    try:
        interval = max(1, int(_db_val("fetch_interval_minutes") or app_settings.fetch_interval_minutes))
    except (TypeError, ValueError):
        interval = max(1, int(app_settings.fetch_interval_minutes))

    # Prefer the timestamp written by the scheduler process; fall back to estimate
    next_fetch_at_str = _db_val("scheduler_next_run_at")
    if next_fetch_at_str:
        next_fetch_at = next_fetch_at_str  # already an ISO string
    elif last_fetch_at:
        next_fetch_at = (last_fetch_at + timedelta(minutes=interval)).isoformat()
    else:
        next_fetch_at = None

    ok = sum(1 for s in enabled if s.last_status == "ok")
    empty = sum(1 for s in enabled if s.last_status == "empty")
    error = sum(1 for s in enabled if s.last_status == "error")

    return {
        "total": len(all_sources),
        "enabled": len(enabled),
        "ok": ok,
        "empty": empty,
        "error": error,
        "last_fetch_at": last_fetch_at.isoformat() if last_fetch_at else None,
        "next_fetch_at": next_fetch_at,
        "fetch_interval_minutes": interval,
    }


@router.get("", response_model=list[RssSourceOut])
def list_sources(
    category: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(RssSource)
    if category:
        q = q.filter(RssSource.category == category)
    if enabled is not None:
        q = q.filter(RssSource.enabled == enabled)
    return q.order_by(RssSource.category, RssSource.id).all()


@router.post("", response_model=RssSourceOut, status_code=201)
def create_source(body: RssSourceCreate, db: Session = Depends(get_db)):
    existing = db.query(RssSource).filter(RssSource.url == body.url.strip()).first()
    if existing:
        raise HTTPException(status_code=409, detail="Source with this URL already exists")
    src = RssSource(
        url=body.url.strip(),
        category=body.category.strip().lower(),
        name=(body.name or "").strip() or None,
        enabled=body.enabled,
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return src


@router.put("/{source_id}", response_model=RssSourceOut)
def update_source(source_id: int, body: RssSourceUpdate, db: Session = Depends(get_db)):
    src = db.query(RssSource).filter(RssSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    data = body.model_dump(exclude_none=True)
    if "url" in data:
        src.url = data["url"].strip()
    if "category" in data:
        src.category = data["category"].strip().lower()
    if "name" in data:
        src.name = (data["name"] or "").strip() or None
    if "enabled" in data:
        src.enabled = data["enabled"]
    db.commit()
    db.refresh(src)
    return src


@router.delete("/{source_id}")
def delete_source(source_id: int, db: Session = Depends(get_db)):
    src = db.query(RssSource).filter(RssSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    db.delete(src)
    db.commit()
    return {"deleted": True, "id": source_id}


class BulkCreateIn(BaseModel):
    urls: List[str]
    category: str
    enabled: bool = True


class BulkCreateResult(BaseModel):
    added: int
    duplicates: int
    invalid: int
    errors: List[str] = []


@router.post("/bulk", response_model=BulkCreateResult)
def bulk_create(body: BulkCreateIn, db: Session = Depends(get_db)):
    """Add many feeds in one call. Skips duplicates silently, reports invalid rows."""
    category = body.category.strip().lower() or "manual"
    added = duplicates = invalid = 0
    errors: List[str] = []
    seen_in_request: set[str] = set()
    for raw in body.urls:
        url = (raw or "").strip()
        if not url:
            invalid += 1
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            invalid += 1
            errors.append(f"not an http(s) URL: {url[:80]}")
            continue
        if url in seen_in_request:
            duplicates += 1
            continue
        seen_in_request.add(url)
        if db.query(RssSource).filter(RssSource.url == url).first():
            duplicates += 1
            continue
        db.add(RssSource(url=url, category=category, enabled=body.enabled))
        added += 1
    if added:
        db.commit()
    return BulkCreateResult(added=added, duplicates=duplicates, invalid=invalid, errors=errors[:10])


class CategoryAction(BaseModel):
    category: str
    enabled: Optional[bool] = None  # if set, update all feeds in category to this enabled state
    rename_to: Optional[str] = None  # if set, move all feeds in `category` to this new category


@router.post("/category-action")
def category_action(body: CategoryAction, db: Session = Depends(get_db)):
    """Bulk operations on every feed in a category: enable/disable all, or rename."""
    src_cat = body.category.strip().lower()
    rows = db.query(RssSource).filter(RssSource.category == src_cat).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No feeds in category '{src_cat}'")
    updated = 0
    if body.enabled is not None:
        for s in rows:
            if s.enabled != body.enabled:
                s.enabled = body.enabled
                updated += 1
    if body.rename_to:
        new_cat = body.rename_to.strip().lower()
        if not new_cat:
            raise HTTPException(status_code=422, detail="rename_to cannot be empty")
        for s in rows:
            s.category = new_cat
            updated += 1
    db.commit()
    return {"category": src_cat, "rows": len(rows), "updated": updated}


@router.delete("/category/{category}")
def delete_category(category: str, db: Session = Depends(get_db)):
    """Delete every feed in a category."""
    cat = category.strip().lower()
    rows = db.query(RssSource).filter(RssSource.category == cat).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No feeds in category '{cat}'")
    for s in rows:
        db.delete(s)
    db.commit()
    return {"deleted": len(rows), "category": cat}


class BulkIdsIn(BaseModel):
    ids: List[int]


@router.post("/bulk-delete")
def bulk_delete_sources(body: BulkIdsIn, db: Session = Depends(get_db)):
    """Delete multiple RSS sources by their IDs in one request."""
    if not body.ids:
        return {"deleted": 0}
    rows = db.query(RssSource).filter(RssSource.id.in_(body.ids)).all()
    for src in rows:
        db.delete(src)
    db.commit()
    logger.info("[bulk-delete] deleted %d sources: %s", len(rows), body.ids[:20])
    return {"deleted": len(rows)}


@router.post("/bulk-fetch")
def bulk_fetch_sources(body: BulkIdsIn, db: Session = Depends(get_db)):
    """Manually trigger an RSS fetch for a specific set of source IDs.
    Runs each feed synchronously and returns total new-article count."""
    from ..services.news_fetcher import _fetch_rss_feed  # local import to avoid circular
    if not body.ids:
        return {"sources_fetched": 0, "new_articles": 0}
    sources = db.query(RssSource).filter(RssSource.id.in_(body.ids)).all()
    new_ids: list[int] = []
    errors = 0
    for src in sources:
        try:
            ids = _fetch_rss_feed(src, db)
            new_ids.extend(ids)
        except Exception as exc:
            errors += 1
            logger.warning("[bulk-fetch] failed for source %d (%s): %s", src.id, src.url[:80], exc)
    logger.info("[bulk-fetch] fetched %d sources → %d new articles (%d errors)",
                len(sources), len(new_ids), errors)
    return {"sources_fetched": len(sources), "new_articles": len(new_ids), "errors": errors}


@router.post("/reseed")
def reseed_sources(db: Session = Depends(get_db)):
    """Add any feeds from RSS_FEEDS that are missing from the DB (won't touch existing rows)."""
    # Pre-load all existing URLs into a set to avoid N+1 queries and prevent
    # duplicate inserts when the same URL appears in multiple categories.
    existing_urls: set[str] = {row.url for row in db.query(RssSource.url).all()}
    added = 0
    for category, urls in RSS_FEEDS.items():
        for url in urls:
            if url not in existing_urls:
                db.add(RssSource(url=url, category=category, enabled=True))
                existing_urls.add(url)  # prevent double-add within the same batch
                added += 1
    if added:
        db.commit()
    return {"added": added}
