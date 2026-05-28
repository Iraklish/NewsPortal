"""Application logging — file-based with hourly rotation and configurable retention.

Two log files are maintained under `backend/logs/`:
  - app.log     : everything from the Python `logging` module (backend internals)
  - client.log  : errors POSTed from the browser via /logs/client

Both rotate hourly. `backupCount` == retention_hours, so e.g. 24 keeps the last
24 hourly files (~1 day). Default is read from config; can be overridden by
storing `log_retention_hours` in the AppSettings table.

Windows-specific note
─────────────────────
Python's `TimedRotatingFileHandler` rotates by calling `os.rename(src, dst)`.
On Windows this raises `PermissionError` (WinError 32) whenever *any* other
handle — in the same process or in a sibling subprocess (e.g. uvicorn --reload
worker) — still has the log file open.

Two mitigations are applied here:

1. **One handler per file** — uvicorn loggers are set to ``propagate = True``
   so their records flow up to the *single* root-logger handler.  Previously
   four `TimedRotatingFileHandler` instances all pointed at ``app.log``; now
   there is exactly one.  This alone eliminates most in-process races.

2. **Graceful PermissionError swallow** — ``_WinSafeTimedRotatingFileHandler``
   catches any ``PermissionError`` raised inside ``rotate()`` and skips the
   rename.  The file keeps growing until the next rotation tick succeeds.
   This is a safety net for the cross-process case (reload worker).
"""
import logging
import os
import sys
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Optional

from .config import settings as app_settings

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
APP_LOG = LOG_DIR / "app.log"
CLIENT_LOG = LOG_DIR / "client.log"
SCHEDULER_LOG = LOG_DIR / "scheduler.log"

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s — %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# Marker used to find handlers we own when reconfiguring at runtime.
_HANDLER_TAG = "_newsportal_managed"


class _WinSafeTimedRotatingFileHandler(TimedRotatingFileHandler):
    """``TimedRotatingFileHandler`` that swallows ``PermissionError`` on Windows.

    ``os.rename`` raises WinError 32 when the file is open by another handle
    (sibling subprocess, IDE, antivirus).  Catching the error here lets the
    logger keep writing to the un-rotated file rather than crashing the process.
    The next hourly tick will attempt rotation again.
    """

    if sys.platform == "win32":
        def rotate(self, source: str, dest: str) -> None:  # type: ignore[override]
            try:
                super().rotate(source, dest)
            except PermissionError:
                # Skip rotation silently — file will be rotated on the next tick.
                pass


def _resolve_retention_hours(db=None) -> int:
    """Effective retention — DB override → env/config → default 24."""
    if db is not None:
        try:
            from .models import AppSettings
            row = db.query(AppSettings).filter(AppSettings.key == "log_retention_hours").first()
            if row and row.value and row.value.strip():
                v = int(row.value)
                if v > 0:
                    return v
        except Exception:
            pass
    try:
        return max(1, int(app_settings.log_retention_hours))
    except Exception:
        return 24


def _resolve_log_level(db=None) -> int:
    name = app_settings.log_level
    if db is not None:
        try:
            from .models import AppSettings
            row = db.query(AppSettings).filter(AppSettings.key == "log_level").first()
            if row and row.value and row.value.strip():
                name = row.value
        except Exception:
            pass
    return getattr(logging, (name or "INFO").upper(), logging.INFO)


def _make_rotating_handler(path: Path, retention_hours: int) -> _WinSafeTimedRotatingFileHandler:
    handler = _WinSafeTimedRotatingFileHandler(
        filename=path,
        when="H",
        interval=1,
        backupCount=retention_hours,
        utc=False,
        encoding="utf-8",
        delay=True,   # Don't open the file until the first log record is written
    )
    handler.setFormatter(logging.Formatter(_FORMAT, _DATE_FORMAT))
    setattr(handler, _HANDLER_TAG, True)
    return handler


def configure_logging(db=None, app_log_path: Optional[Path] = None) -> None:
    """Install / reinstall our file handlers on the root logger (and uvicorn loggers
    when running as the API process).

    Parameters
    ----------
    db:
        Optional SQLAlchemy session used to read DB-overridable settings.
    app_log_path:
        Override the log file path.  Pass ``SCHEDULER_LOG`` from the scheduler
        process so each process writes to its own file and Windows file-locking
        during hourly rotation never affects the other process.  When *None*
        (default) the API process uses the standard ``APP_LOG`` path and also
        attaches handlers to the uvicorn loggers.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    retention = _resolve_retention_hours(db)
    level = _resolve_log_level(db)

    log_path = app_log_path if app_log_path is not None else APP_LOG
    # Only the API process (default path) needs uvicorn logger handlers.
    is_api_process = app_log_path is None
    managed_loggers = ("", "uvicorn", "uvicorn.access", "uvicorn.error") if is_api_process else ("",)

    # Remove previously installed handlers (idempotent reconfigure)
    for logger_name in managed_loggers:
        lg = logging.getLogger(logger_name)
        for h in list(lg.handlers):
            if getattr(h, _HANDLER_TAG, False):
                lg.removeHandler(h)
                try: h.close()
                except Exception: pass

    app_handler = _make_rotating_handler(log_path, retention)
    app_handler.setLevel(level)

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(app_handler)

    # Uvicorn loggers: propagate to root so their records reach the single file
    # handler above.  We do NOT add separate file handlers — that was the old
    # approach and created 4 competing handles on app.log, causing WinError 32
    # when the hourly rotation fired.
    if is_api_process:
        for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
            ulg = logging.getLogger(name)
            # Remove any duplicate managed handlers left from a previous configure call.
            for h in list(ulg.handlers):
                if getattr(h, _HANDLER_TAG, False):
                    ulg.removeHandler(h)
                    try:
                        h.close()
                    except Exception:
                        pass
            ulg.setLevel(level)
            ulg.propagate = True  # records bubble up to root → single file handler


def get_client_logger() -> logging.Logger:
    """Logger that writes to client.log (frontend error reports)."""
    logger = logging.getLogger("newsportal.client")
    if not any(getattr(h, _HANDLER_TAG, False) for h in logger.handlers):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = _make_rotating_handler(CLIENT_LOG, _resolve_retention_hours())
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", _DATE_FORMAT))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False  # don't duplicate into app.log
    return logger


def prune_old_logs(retention_hours: Optional[int] = None) -> int:
    """Delete rotated log files older than retention. Returns count removed.

    Called explicitly when the retention setting changes (TimedRotatingFileHandler
    only prunes on its own rotation cycle).
    """
    if retention_hours is None:
        retention_hours = _resolve_retention_hours()
    cutoff = time.time() - retention_hours * 3600
    removed = 0
    if not LOG_DIR.exists():
        return 0
    for p in LOG_DIR.iterdir():
        if not p.is_file():
            continue
        # Only touch our own files
        if not (p.name.startswith("app.log") or p.name.startswith("client.log")
                or p.name.startswith("scheduler.log")):
            continue
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except Exception:
            pass
    return removed
