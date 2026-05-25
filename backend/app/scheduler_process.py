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

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Make sure the app package is importable when run directly.
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings as cfg
from app.database import SessionLocal, init_db
from app.logging_config import configure_logging, SCHEDULER_LOG
from app.models import AppSettings, Article, Analysis
from app.services.analyzer import analyze_article
from app.services.news_fetcher import fetch_all_sources

logger = logging.getLogger(__name__)

# Threading event used by the signal handler (safe to set from any thread).
_stop_flag = threading.Event()

# Monotonically-increasing cycle counter (module-level so signal handler can reference it).
_cycle_count = 0


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


def _should_prune(db) -> bool:
    """Return True if a retention prune is due (once per 23 h, persisted in DB)."""
    raw = _db_get(db, "scheduler_last_prune_at")
    if not raw:
        return True
    try:
        last = datetime.fromisoformat(raw)
        return datetime.now(timezone.utc).replace(tzinfo=None) - last >= timedelta(hours=23)
    except Exception:
        return True


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
    global _cycle_count
    _cycle_count += 1
    cycle_num = _cycle_count
    t_start = datetime.now(timezone.utc).replace(tzinfo=None)

    logger.info("[scheduler] ── cycle #%d starting ──────────────────────────", cycle_num)
    db = SessionLocal()
    try:
        new_ids = await fetch_all_sources(db)
        elapsed_fetch = (datetime.now(timezone.utc).replace(tzinfo=None) - t_start).total_seconds()
        logger.info("[scheduler] cycle #%d — fetch complete: %d new article(s) in %.1fs",
                    cycle_num, len(new_ids), elapsed_fetch)

        # Persist last-run timestamp for the API status widget.
        _db_set(db, "scheduler_last_run_at", datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
        db.commit()

        if not new_ids:
            elapsed = (datetime.now(timezone.utc).replace(tzinfo=None) - t_start).total_seconds()
            logger.info("[scheduler] cycle #%d complete — nothing new (%.1fs total)",
                        cycle_num, elapsed)
            return

        if not _auto_analyze_enabled(db):
            logger.info("[scheduler] cycle #%d — auto-analyze disabled, skipping %d article(s)",
                        cycle_num, len(new_ids))
            return

        cap = max(0, int(cfg.max_auto_analyze_per_run))
        to_analyze = new_ids[:cap]
        skipped = len(new_ids) - len(to_analyze)
        logger.info(
            "[scheduler] cycle #%d — will analyze %d article(s) (cap=%d%s)",
            cycle_num, len(to_analyze), cap,
            f", {skipped} skipped by cap" if skipped else "",
        )

        analyzed_ok = analyzed_err = 0
        for i, article_id in enumerate(to_analyze, 1):
            if _stop_flag.is_set():
                logger.info("[scheduler] cycle #%d — shutdown signal: stopping after %d/%d analyzed",
                            cycle_num, i - 1, len(to_analyze))
                break
            article = db.query(Article).filter(Article.id == article_id).first()
            if not article:
                logger.debug("[scheduler] cycle #%d — article %d not found, skipping", cycle_num, article_id)
                continue
            title_short = (article.title or "").strip()[:70]
            logger.debug("[scheduler] cycle #%d — analyzing %d/%d: %s",
                         cycle_num, i, len(to_analyze), title_short)
            t_art = datetime.now(timezone.utc).replace(tzinfo=None)
            try:
                await analyze_article(article, db)
                art_elapsed = (datetime.now(timezone.utc).replace(tzinfo=None) - t_art).total_seconds()
                logger.info("[scheduler] cycle #%d — [%d/%d] OK (%.1fs): %s",
                            cycle_num, i, len(to_analyze), art_elapsed, title_short)
                analyzed_ok += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("[scheduler] cycle #%d — [%d/%d] FAIL: %s | %s",
                               cycle_num, i, len(to_analyze), title_short, exc)
                analyzed_err += 1

        elapsed = (datetime.now(timezone.utc).replace(tzinfo=None) - t_start).total_seconds()
        logger.info(
            "[scheduler] cycle #%d complete — %d analyzed OK, %d errors (%.1fs total)",
            cycle_num, analyzed_ok, analyzed_err, elapsed,
        )

    except asyncio.CancelledError:
        logger.info("[scheduler] cycle #%d cancelled during shutdown", cycle_num)
    except Exception as exc:
        logger.exception("[scheduler] cycle #%d failed: %s", cycle_num, exc)
    finally:
        db.close()


# ── Daily retention prune ────────────────────────────────────────────────────

def _retention_prune() -> None:
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=int(cfg.retention_days))
    db = SessionLocal()
    try:
        old = db.query(Article).filter(Article.fetched_at < cutoff).all()
        if not old:
            logger.info("[scheduler] retention prune: nothing to delete (cutoff %s)", cutoff.date())
        else:
            old_ids = [a.id for a in old]
            deleted_analyses = (
                db.query(Analysis)
                .filter(Analysis.article_id.in_(old_ids))
                .delete(synchronize_session=False)
            )
            for a in old:
                db.delete(a)
            logger.info("[scheduler] retention prune: deleted %d articles, %d analyses", len(old), deleted_analyses)
        # Always record that we ran the prune so --once mode doesn't re-prune immediately.
        _db_set(db, "scheduler_last_prune_at", datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("[scheduler] retention prune failed: %s", exc)
    finally:
        db.close()


# ── Main loop ────────────────────────────────────────────────────────────────

async def main(once: bool = False) -> None:
    """Run the scheduler.

    Parameters
    ----------
    once:
        When True, run exactly one fetch-and-analyse cycle, run a retention
        prune if one is due, then return.  This is the mode used by
        ``scheduler_launcher.py``, which manages the inter-cycle sleep itself
        and spawns a fresh subprocess for each cycle.
    """
    init_db()

    db = SessionLocal()
    try:
        # Use scheduler.log so this process never competes with the API process
        # for app.log during hourly rotation (Windows raises "file in use" otherwise).
        configure_logging(db, app_log_path=SCHEDULER_LOG)
    finally:
        db.close()

    # Mirror all log output to stderr so the terminal shows scheduler activity.
    _console = logging.StreamHandler(sys.stderr)
    _console.setLevel(logging.DEBUG)
    _console.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        "%Y-%m-%d %H:%M:%S",
    ))
    logging.getLogger().addHandler(_console)

    logger.info("[scheduler] ════════════════════════════════════════════════")
    logger.info("[scheduler] process started  PID=%d  mode=%s  log=%s",
                os.getpid(), "once" if once else "loop", SCHEDULER_LOG)

    # Log the active config so it's easy to confirm settings are applied.
    db = SessionLocal()
    try:
        interval_minutes = _get_interval(db)
        auto_analyze = _auto_analyze_enabled(db)
        cap = max(0, int(cfg.max_auto_analyze_per_run))
        logger.info(
            "[scheduler] config  interval=%dmin  auto_analyze=%s  analyze_cap=%d  retention=%dd",
            interval_minutes,
            "ON" if auto_analyze else "OFF",
            cap,
            int(cfg.retention_days),
        )
        logger.info("[scheduler] log file → %s", SCHEDULER_LOG)
    finally:
        db.close()

    logger.info("[scheduler] ════════════════════════════════════════════════")

    # Run one fetch cycle.
    await _run_cycle()

    # Retention prune: in --once mode use the DB-persisted timestamp so we don't
    # prune on every single cycle; in loop mode keep the in-process timer.
    if once:
        db = SessionLocal()
        try:
            should = _should_prune(db)
        finally:
            db.close()
        if should:
            _retention_prune()
        logger.info("[scheduler] --once cycle complete — exiting")
        return

    # ── Loop mode (legacy / direct invocation) ───────────────────────────────
    last_prune = datetime.now(timezone.utc).replace(tzinfo=None)

    while not _stop_flag.is_set():
        # Read the current interval fresh from DB every cycle.
        db = SessionLocal()
        try:
            interval_minutes = _get_interval(db)
            next_run_dt = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=interval_minutes)
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
        if datetime.now(timezone.utc).replace(tzinfo=None) - last_prune >= timedelta(hours=23):
            _retention_prune()
            last_prune = datetime.now(timezone.utc).replace(tzinfo=None)

    logger.info("[scheduler] process stopped cleanly")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="EconomicReview news-fetch scheduler")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run exactly one fetch cycle then exit (used by scheduler_launcher.py)",
    )
    args = parser.parse_args()
    asyncio.run(main(once=args.once))
