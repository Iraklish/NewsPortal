"""Process supervisor for the news-fetch scheduler.

Run this instead of scheduler_process.py directly:

    python -m app.scheduler_launcher          # recommended
    python app/scheduler_launcher.py          # also fine

How it works
────────────
For every fetch cycle the launcher spawns:

    python -m app.scheduler_process --once

That child process runs exactly one fetch-and-analyse cycle, then exits.
The launcher waits for it to finish, reads the current interval from the DB,
sleeps until the next scheduled time, and spawns a fresh child.

Benefits over a single long-running scheduler loop
──────────────────────────────────────────────────
• Each cycle starts with a clean process — no accumulated state or memory
• A crash in one cycle does not affect future cycles; the launcher recovers
• The child is terminated cleanly when the launcher receives SIGTERM / SIGINT
• A PID file prevents two launchers from running simultaneously
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import time
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Make sure the app package is importable when run directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings as cfg
from app.database import SessionLocal, init_db
from app.logging_config import configure_logging, SCHEDULER_LOG
from app.models import AppSettings

logger = logging.getLogger(__name__)

_stop_flag = threading.Event()
_child: subprocess.Popen | None = None   # currently-running worker subprocess

_PID_FILE = Path(__file__).resolve().parent.parent / "logs" / "scheduler_launcher.pid"


# ── Signal handling ──────────────────────────────────────────────────────────

def _on_signal(sig: int, _frame: object) -> None:
    try:
        name = signal.Signals(sig).name
    except ValueError:
        name = str(sig)
    logger.info("[launcher] received %s — stopping after current cycle", name)
    _stop_flag.set()
    # Forward the signal to the running child so it can shut down cleanly too.
    if _child and _child.poll() is None:
        logger.info("[launcher] forwarding %s to child PID=%d", name, _child.pid)
        try:
            _child.send_signal(sig)
        except Exception:
            pass


signal.signal(signal.SIGTERM, _on_signal)
try:
    signal.signal(signal.SIGINT, _on_signal)
except OSError:
    pass  # SIGINT unavailable in some environments (Windows services)


# ── PID-file helpers (single-instance guard) ─────────────────────────────────

def _write_pid() -> None:
    try:
        _PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        _PID_FILE.write_text(str(os.getpid()))
    except Exception:
        pass


def _clear_pid() -> None:
    try:
        _PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _kill_existing_launcher() -> None:
    """If another launcher is already running, send it SIGTERM and wait briefly."""
    if not _PID_FILE.exists():
        return
    try:
        old_pid = int(_PID_FILE.read_text().strip())
    except Exception:
        _clear_pid()
        return
    if old_pid == os.getpid():
        return  # That's us somehow
    try:
        os.kill(old_pid, 0)   # signal 0 = existence check only
        logger.warning("[launcher] existing launcher PID=%d found — sending SIGTERM", old_pid)
        os.kill(old_pid, signal.SIGTERM)
        # Give it up to 5 s to exit before we take over
        for _ in range(50):
            time.sleep(0.1)
            try:
                os.kill(old_pid, 0)
            except (ProcessLookupError, PermissionError):
                break
    except (ProcessLookupError, PermissionError):
        pass  # Already dead
    _clear_pid()


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


# ── Worker subprocess ────────────────────────────────────────────────────────

def _spawn_cycle() -> int:
    """Spawn ``scheduler_process --once`` and block until it exits.

    Returns the child's exit code (0 = success).
    """
    global _child
    cwd = str(Path(__file__).resolve().parent.parent)
    cmd = [sys.executable, "-m", "app.scheduler_process", "--once"]

    logger.info("[launcher] ── spawning scheduler worker ────────────────────")
    _child = subprocess.Popen(cmd, cwd=cwd)
    logger.info("[launcher] child PID=%d started", _child.pid)

    exit_code = _child.wait()
    _child = None

    if exit_code == 0:
        logger.info("[launcher] child exited cleanly (code 0)")
    else:
        logger.warning("[launcher] child exited with code %d", exit_code)
    return exit_code


# ── Interruptible sleep ──────────────────────────────────────────────────────

def _sleep_interruptible(seconds: float) -> bool:
    """Sleep in 1-second ticks. Returns True if the stop flag was set."""
    remaining = seconds
    while remaining > 0 and not _stop_flag.is_set():
        time.sleep(min(1.0, remaining))
        remaining -= 1.0
    return _stop_flag.is_set()


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    init_db()

    db = SessionLocal()
    try:
        configure_logging(db, app_log_path=SCHEDULER_LOG)
    finally:
        db.close()

    # Mirror all log output to stderr so the terminal shows launcher activity.
    _console = logging.StreamHandler(sys.stderr)
    _console.setLevel(logging.DEBUG)
    _console.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        "%Y-%m-%d %H:%M:%S",
    ))
    logging.getLogger().addHandler(_console)

    # Enforce single launcher instance via PID file.
    _kill_existing_launcher()
    _write_pid()

    logger.info("[launcher] ════════════════════════════════════════════════")
    logger.info("[launcher] supervisor started  PID=%d  log=%s", os.getpid(), SCHEDULER_LOG)
    logger.info("[launcher] worker: python -m app.scheduler_process --once")
    logger.info("[launcher] ════════════════════════════════════════════════")

    try:
        # Run first cycle immediately on startup.
        _spawn_cycle()

        while not _stop_flag.is_set():
            # Read interval fresh from DB so Settings UI changes take effect immediately.
            db = SessionLocal()
            try:
                interval = _get_interval(db)
                next_run = (
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    + timedelta(minutes=interval)
                )
                _db_set(db, "scheduler_next_run_at", next_run.isoformat())
                db.commit()
            finally:
                db.close()

            logger.info(
                "[launcher] sleeping %d min — next cycle at %s",
                interval,
                next_run.strftime("%H:%M:%S"),
            )

            if _sleep_interruptible(interval * 60):
                break

            _spawn_cycle()

    finally:
        _clear_pid()

    logger.info("[launcher] stopped cleanly")


if __name__ == "__main__":
    main()
