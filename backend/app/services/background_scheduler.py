"""Async background scheduler — runs as an asyncio task inside the FastAPI process.

Started by ``app.main`` lifespan via ``asyncio.create_task(run_scheduler())``.
Cancelled cleanly when the server shuts down (uvicorn sends CancelledError).

Why this replaces scheduler_launcher.py + scheduler_process.py
──────────────────────────────────────────────────────────────
The old design spawned a *separate OS process* for each fetch cycle.  That
worked fine on Linux/macOS (where fork+signal are trivial) but caused a chain
of failures on Windows:

  * os.kill(pid, 0) → WinError 11 (signal-0 not supported)
  * SIGTERM forwarding → TerminateProcess (force-kill, not clean shutdown)
  * PID-file races when the launcher restarted quickly
  * Two separate console windows just to run one scheduler

Running the scheduler as an asyncio background task inside the same uvicorn
process eliminates ALL of the above:

  * No subprocesses, no PID files, no signals
  * asyncio.CancelledError propagates cleanly through every await point
  * One console window for backend + scheduler combined
  * Works identically on Windows, Linux, and macOS
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from ..config import settings as cfg
from ..database import SessionLocal
from ..models import AppSettings, Article, Analysis
from .analyzer import analyze_article
from .news_fetcher import fetch_all_sources
from .telegram_fetcher import fetch_all_telegram_sources

logger = logging.getLogger(__name__)

_cycle_count = 0


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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


def _should_prune(db) -> bool:
    raw = _db_get(db, "scheduler_last_prune_at")
    if not raw:
        return True
    try:
        last = datetime.fromisoformat(raw)
        return _now() - last >= timedelta(hours=23)
    except Exception:
        return True


def _get_auto_tag_categories(db) -> set[str]:
    """Return the set of category names that have auto-tagging enabled."""
    raw = _db_get(db, "auto_tag_categories")
    if not raw:
        return set()
    try:
        cats = json.loads(raw)
        return set(cats) if isinstance(cats, list) else set()
    except Exception:
        return set()


# ── Retention prune (synchronous — DB only, no I/O) ─────────────────────────

def _retention_prune() -> None:
    cutoff = _now() - timedelta(days=int(cfg.retention_days))
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
            logger.info(
                "[scheduler] retention prune: deleted %d article(s), %d analysis records",
                len(old), deleted_analyses,
            )
        _db_set(db, "scheduler_last_prune_at", _now().isoformat())
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("[scheduler] retention prune failed: %s", exc)
    finally:
        db.close()


# ── Fetch + analyse cycle ────────────────────────────────────────────────────

async def _run_cycle() -> None:
    global _cycle_count
    _cycle_count += 1
    cycle_num = _cycle_count
    t_start = _now()

    logger.info("[scheduler] ── cycle #%d starting ──────────────────────────", cycle_num)
    db = SessionLocal()
    try:
        # Stamp the cycle start immediately so the UI shows a fresh timestamp
        # even while the (potentially long) fetch is running.
        _db_set(db, "scheduler_last_run_at", _now().isoformat())
        db.commit()

        # Fetch from RSS/web sources and Telegram channels.
        new_ids = await fetch_all_sources(db)
        tg_ids = await fetch_all_telegram_sources(db)
        new_ids = new_ids + tg_ids

        elapsed_fetch = (_now() - t_start).total_seconds()
        logger.info(
            "[scheduler] cycle #%d — fetch complete: %d new article(s) (%d telegram) in %.1fs",
            cycle_num, len(new_ids), len(tg_ids), elapsed_fetch,
        )

        # ── Auto-tag: tag new articles in categories that have it enabled ────
        auto_tag_cats = _get_auto_tag_categories(db)
        if auto_tag_cats and new_ids:
            from .tagger import ai_extract_tags
            _AUTO_TAG_CAP = 20  # safeguard: never tag more than this per cycle
            # Single batch query for all new article categories.
            article_categories: dict[int, str | None] = dict(
                db.query(Article.id, Article.category)
                .filter(Article.id.in_(new_ids))
                .all()
            )
            to_tag = [
                aid for aid in new_ids
                if article_categories.get(aid) in auto_tag_cats
            ][:_AUTO_TAG_CAP]
            if to_tag:
                logger.info(
                    "[scheduler] cycle #%d — auto-tagging %d article(s) in categories %s",
                    cycle_num, len(to_tag), sorted(auto_tag_cats),
                )
                tag_ok = tag_err = 0
                for aid in to_tag:
                    article = db.query(Article).filter(Article.id == aid).first()
                    if not article or article.tags:
                        continue  # skip already-tagged articles
                    try:
                        article.tags = await ai_extract_tags(article, db)
                        db.commit()
                        tag_ok += 1
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        logger.debug(
                            "[scheduler] cycle #%d — auto-tag failed for article %d: %s",
                            cycle_num, aid, exc,
                        )
                        tag_err += 1
                logger.info(
                    "[scheduler] cycle #%d — auto-tag complete: %d tagged, %d errors",
                    cycle_num, tag_ok, tag_err,
                )

        if not new_ids:
            logger.info(
                "[scheduler] cycle #%d complete — nothing new (%.1fs total)",
                cycle_num, (_now() - t_start).total_seconds(),
            )
            return

        if not _auto_analyze_enabled(db):
            logger.info(
                "[scheduler] cycle #%d — auto-analyze disabled, skipping %d article(s)",
                cycle_num, len(new_ids),
            )
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
            article = db.query(Article).filter(Article.id == article_id).first()
            if not article:
                logger.debug("[scheduler] cycle #%d — article %d not found, skipping", cycle_num, article_id)
                continue

            title_short = (article.title or "").strip()[:70]
            t_art = _now()
            try:
                await analyze_article(article, db)
                art_elapsed = (_now() - t_art).total_seconds()
                logger.info(
                    "[scheduler] cycle #%d — [%d/%d] OK (%.1fs): %s",
                    cycle_num, i, len(to_analyze), art_elapsed, title_short,
                )
                analyzed_ok += 1
            except asyncio.CancelledError:
                raise  # Let the outer handler deal with clean shutdown
            except Exception as exc:
                logger.warning(
                    "[scheduler] cycle #%d — [%d/%d] FAIL: %s | %s",
                    cycle_num, i, len(to_analyze), title_short, exc,
                )
                analyzed_err += 1

        elapsed = (_now() - t_start).total_seconds()
        logger.info(
            "[scheduler] cycle #%d complete — %d analyzed OK, %d errors (%.1fs total)",
            cycle_num, analyzed_ok, analyzed_err, elapsed,
        )

    except asyncio.CancelledError:
        logger.info("[scheduler] cycle #%d cancelled during shutdown", cycle_num)
        raise
    except Exception as exc:
        logger.exception("[scheduler] cycle #%d failed: %s", cycle_num, exc)
    finally:
        db.close()


# ── Main coroutine ───────────────────────────────────────────────────────────

async def run_scheduler() -> None:
    """Run the news-fetch scheduler forever as an asyncio background task.

    The first cycle fires immediately on startup.  After each cycle the task
    reads the current fetch interval from the DB (so Settings UI changes take
    effect on the next tick), writes ``scheduler_next_run_at``, and sleeps.

    On shutdown, uvicorn cancels this task; ``asyncio.CancelledError`` propagates
    through any active ``await`` (sleep or fetch) and we exit cleanly.
    """
    logger.info("[scheduler] background task started (runs inside the API process)")

    # Log active config once at startup.
    db = SessionLocal()
    try:
        interval = _get_interval(db)
        auto_analyze = _auto_analyze_enabled(db)
        cap = max(0, int(cfg.max_auto_analyze_per_run))
        logger.info(
            "[scheduler] config  interval=%dmin  auto_analyze=%s  analyze_cap=%d  retention=%dd",
            interval,
            "ON" if auto_analyze else "OFF",
            cap,
            int(cfg.retention_days),
        )
    finally:
        db.close()

    first_cycle = True
    last_prune = _now()

    while True:
        try:
            # On subsequent cycles: compute next-run time, persist it, then sleep.
            if first_cycle:
                first_cycle = False
            else:
                db = SessionLocal()
                try:
                    interval = _get_interval(db)
                    next_run = _now() + timedelta(minutes=interval)
                    _db_set(db, "scheduler_next_run_at", next_run.isoformat())
                    db.commit()
                finally:
                    db.close()

                logger.info(
                    "[scheduler] sleeping %d min — next cycle at %s",
                    interval, next_run.strftime("%H:%M:%S"),
                )
                await asyncio.sleep(interval * 60)

            # Run one fetch + analyse cycle.
            # Hard timeout prevents a hung feed from blocking the scheduler forever.
            _CYCLE_TIMEOUT = 25 * 60  # 25 minutes
            try:
                await asyncio.wait_for(_run_cycle(), timeout=_CYCLE_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning(
                    "[scheduler] cycle exceeded %d min timeout — aborting, next cycle starts shortly",
                    _CYCLE_TIMEOUT // 60,
                )

            # Daily retention prune (once per 23+ hours).
            if _now() - last_prune >= timedelta(hours=23):
                _retention_prune()
                last_prune = _now()

        except asyncio.CancelledError:
            logger.info("[scheduler] background task stopped cleanly")
            return
        except Exception as exc:
            # A bug in the loop should not take down the whole scheduler.
            # Wait briefly, then try again.
            logger.exception("[scheduler] unexpected error — will retry in 30s: %s", exc)
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                logger.info("[scheduler] background task stopped cleanly (during error recovery)")
                return
