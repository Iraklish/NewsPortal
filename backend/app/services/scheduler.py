"""Scheduler helpers used by the API layer.

The periodic fetch schedule now runs in a separate process
(app/scheduler_process.py).  This module only exposes run_fetch_now(),
which is called by the POST /articles/fetch-all endpoint for on-demand fetches.
"""
import logging

from ..database import SessionLocal
from ..models import AppSettings
from ..config import settings
from .news_fetcher import fetch_all_sources
from .analyzer import analyze_article
from ..models import Article

logger = logging.getLogger(__name__)


def _auto_analyze_enabled(db) -> bool:
    row = db.query(AppSettings).filter(AppSettings.key == "auto_analyze_enabled").first()
    if row and row.value:
        return row.value.strip().lower() in ("1", "true", "yes", "on")
    return bool(settings.auto_analyze_enabled)


async def run_fetch_now() -> list[int]:
    """Manual trigger: same fetch+analyze logic the scheduler runs periodically.

    Called by POST /articles/fetch-all.  Runs in the API process (fine for
    on-demand use; the scheduler process handles the periodic heavy lifting).
    """
    db = SessionLocal()
    try:
        new_ids = await fetch_all_sources(db)
        if not _auto_analyze_enabled(db):
            return new_ids
        cap = max(0, int(settings.max_auto_analyze_per_run))
        for article_id in new_ids[:cap]:
            article = db.query(Article).filter(Article.id == article_id).first()
            if article:
                try:
                    await analyze_article(article, db)
                except Exception as exc:
                    logger.warning("manual fetch: analysis failed for %s: %s", article_id, exc)
        return new_ids
    finally:
        db.close()
