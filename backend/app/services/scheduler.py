"""APScheduler jobs: hourly news fetch + auto-analyze, daily retention prune."""
import asyncio
import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from ..config import settings
from ..database import SessionLocal
from ..models import Analysis, AppSettings, Article
from .analyzer import analyze_article
from .news_fetcher import fetch_all_sources


def _auto_analyze_enabled(db) -> bool:
    """DB override beats config default."""
    row = db.query(AppSettings).filter(AppSettings.key == "auto_analyze_enabled").first()
    if row and row.value:
        return row.value.strip().lower() in ("1", "true", "yes", "on")
    return bool(settings.auto_analyze_enabled)

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


# ── Jobs ─────────────────────────────────────────────────────────────────────

async def fetch_and_analyze_job():
    """Periodic fetch: grab new articles, then auto-analyze up to the configured cap."""
    db = SessionLocal()
    try:
        logger.info("[scheduler] starting scheduled fetch")
        new_ids = await fetch_all_sources(db)
        logger.info("[scheduler] fetched %d new articles", len(new_ids))

        if not new_ids:
            return

        if not _auto_analyze_enabled(db):
            logger.info("[scheduler] auto-analyze disabled; skipping AI passes for %d new articles", len(new_ids))
            return

        cap = max(0, int(settings.max_auto_analyze_per_run))
        to_analyze = new_ids[:cap] if cap else []
        logger.info("[scheduler] auto-analyzing %d / %d new articles (cap=%d)",
                    len(to_analyze), len(new_ids), cap)

        for article_id in to_analyze:
            article = db.query(Article).filter(Article.id == article_id).first()
            if not article:
                continue
            try:
                await analyze_article(article, db)
            except Exception as exc:
                logger.warning("[scheduler] analysis failed for article %s: %s", article_id, exc)
    except Exception as exc:
        logger.exception("[scheduler] fetch_and_analyze_job failed: %s", exc)
    finally:
        db.close()


def retention_prune_job():
    """Daily: delete articles (and their analyses) older than retention_days."""
    cutoff = datetime.utcnow() - timedelta(days=int(settings.retention_days))
    db = SessionLocal()
    try:
        old = db.query(Article).filter(Article.fetched_at < cutoff).all()
        if not old:
            logger.info("[scheduler] retention prune: nothing to delete (cutoff=%s)", cutoff.date())
            return

        old_ids = [a.id for a in old]
        deleted_analyses = (
            db.query(Analysis)
            .filter(Analysis.article_id.in_(old_ids))
            .delete(synchronize_session=False)
        )
        for a in old:
            db.delete(a)
        db.commit()
        logger.info("[scheduler] retention prune: deleted %d articles, %d analyses (older than %s)",
                    len(old), deleted_analyses, cutoff.date())
    except Exception as exc:
        db.rollback()
        logger.exception("[scheduler] retention_prune_job failed: %s", exc)
    finally:
        db.close()


# ── Lifecycle ────────────────────────────────────────────────────────────────

def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    _scheduler = AsyncIOScheduler()

    interval = max(1, int(settings.fetch_interval_minutes))
    _scheduler.add_job(
        fetch_and_analyze_job,
        trigger=IntervalTrigger(minutes=interval),
        id="fetch_and_analyze",
        name=f"News fetch every {interval} min + auto-analyze",
        next_run_time=datetime.now() + timedelta(seconds=30),  # run shortly after startup (local TZ)
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )

    _scheduler.add_job(
        retention_prune_job,
        trigger=CronTrigger(hour=3, minute=0),
        id="retention_prune",
        name=f"Daily retention prune (>{settings.retention_days}d)",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )

    _scheduler.start()
    logger.info("[scheduler] started (fetch every %d min, retention %d days)",
                interval, settings.retention_days)
    return _scheduler


def stop_scheduler():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("[scheduler] stopped")


async def run_fetch_now() -> list[int]:
    """Manual trigger used by the API endpoint."""
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
