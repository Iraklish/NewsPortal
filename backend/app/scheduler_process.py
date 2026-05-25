"""Standalone news-fetch scheduler — run in a SEPARATE process from the API server.

Usage (from the backend/ directory):
    python -m app.scheduler_process

The process is fully decoupled from uvicorn. It reads the fetch interval from
the database before every sleep, so changes made via the Settings UI take effect
on the next tick without restarting this process.

It also writes two AppSettings keys that the API reads:
  scheduler_last_run_at   — ISO timestamp of the most recent completed cycle
  scheduler_next_run_at   — ISO timestamp of the next planned cycle
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

# Make sure the app package is importable when run directly.
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings as cfg
from app.database import SessionLocal, init_db
from app.logging_config import configure_logging
from app.models import AppSettings, Article, Analysis
from app.services.analyzer import analyze_article
from app.services.news_fetcher import fetch_all_sources

logger = logging.getLogger(__name__)

# Threading event used by the signal handler (safe to set from any thread).
_stop_flag = threading.Event()


# ── Signal handling ──────────────────────────────────────────────────────────

def _on_signal(sig: int, _frame: object) -> None:
    try:
        name = signal.Signals(sig).name
    except ValueError:
        name = str(sig)
    logger.info("[scheduler] received %s — will stop after current run", name)
    _stop_flag.set()


signal.signal(signal.SIGTERM, _on_signal)
try:
    signal.signal(signal.SIGINT, _on_signal)
except OSError:
    pass  # SIGINT may be unavailable in some environments (e.g. Windows services)


# ── DB helpers ───────────────────────────────────────────────────────────────

def _db_get(db, key: str) -> str | None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    return row.value if row else None


def _db_set(db, key: str, value: str) -> None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSettings(key=key, value=value))


def _get_interval(db) -> int:
    raw = _db_get(db, "fetch_interval_minutes") or str(cfg.fetch_interval_minutes)
    try:
        return max(1, int(raw))
    except (ValueError, TypeError):
        return 30


def _auto_analyze_enabled(db) -> bool:
    raw = _db_get(db, "auto_analyze_enabled")
    if raw:
        return raw.strip().lower() in ("1", "true", "yes", "on")
    return bool(cfg.auto_analyze_enabled)


# ── Sleep helper (respects stop_flag) ────────────────────────────────────────

async def _sleep_interruptible(seconds: float) -> bool:
    """Sleep for up to `seconds` in 5-second ticks.

    Returns True if the stop flag was set before the full duration elapsed.
    """
    remaining = seconds
    while remaining > 0 and not _stop_flag.is_set():
        await asyncio.sleep(min(5.0, remaining))
        remaining -= 5.0
    return _stop_flag.is_set()


# ── Fetch cycle ──────────────────────────────────────────────────────────────

async def _run_cycle() -> None:
    db = SessionLocal()
    try:
        logger.info("[scheduler] starting fetch cycle")
        new_ids = await fetch_all_sources(db)
        logger.info("[scheduler] fetch done — %d new articles", len(new_ids))

        # Persist last-run timestamp for the API status widget.
        _db_set(db, "scheduler_last_run_at", datetime.utcnow().isoformat())
        db.commit()

        if not new_ids:
            return
        if not _auto_analyze_enabled(db):
            logger.info("[scheduler] auto-analyze disabled, skipping")
            return

        cap = max(0, int(cfg.max_auto_analyze_per_run))
        for article_id in new_ids[:cap]:
            if _stop_flag.is_set():
                logger.info("[scheduler] stopping auto-analyze early (shutdown)")
                break
            article = db.query(Article).filter(Article.id == article_id).first()
            if not article:
                continue
            try:
                await analyze_article(article, db)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("[scheduler] analysis failed for article %d: %s", article_id, exc)

    except asyncio.CancelledError:
        logger.info("[scheduler] cycle cancelled during shutdown")
    except Exception as exc:
        logger.exception("[scheduler] cycle failed: %s", exc)
    finally:
        db.close()


# ── Daily retention prune ────────────────────────────────────────────────────

def _retention_prune() -> None:
    cutoff = datetime.utcnow() - timedelta(days=int(cfg.retention_days))
    db = SessionLocal()
    try:
        old = db.query(Article).filter(Article.fetched_at < cutoff).all()
        if not old:
            logger.info("[scheduler] retention prune: nothing to delete (cutoff %s)", cutoff.date())
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
        logger.info("[scheduler] retention prune: deleted %d articles, %d analyses", len(old), deleted_analyses)
    except Exception as exc:
        db.rollback()
        logger.exception("[scheduler] retention prune failed: %s", exc)
    finally:
        db.close()


# ── Main loop ────────────────────────────────────────────────────────────────

async def main() -> None:
    init_db()

    db = SessionLocal()
    try:
        configure_logging(db)
    finally:
        db.close()

    logger.info("[scheduler] process started (PID %d)", os.getpid())

    # Run one cycle immediately on startup.
    await _run_cycle()

    last_prune = datetime.utcnow()

    while not _stop_flag.is_set():
        # Read the current interval fresh from DB every cycle.
        db = SessionLocal()
        try:
            interval_minutes = _get_interval(db)
            next_run_dt = datetime.utcnow() + timedelta(minutes=interval_minutes)
            _db_set(db, "scheduler_next_run_at", next_run_dt.isoformat())
            db.commit()
        finally:
            db.close()

        logger.info("[scheduler] sleeping %d min — next run at %s",
                    interval_minutes, next_run_dt.strftime("%H:%M:%S"))

        interrupted = await _sleep_interruptible(interval_minutes * 60)
        if interrupted:
            break

        await _run_cycle()

        # Daily retention prune (runs once per 23+ hours).
        if datetime.utcnow() - last_prune >= timedelta(hours=23):
            _retention_prune()
            last_prune = datetime.utcnow()

    logger.info("[scheduler] process stopped cleanly")


if __name__ == "__main__":
    asyncio.run(main())
