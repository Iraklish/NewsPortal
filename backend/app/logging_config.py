"""Application logging — file-based with hourly rotation and configurable retention.

Two log files are maintained under `backend/logs/`:
  - app.log     : everything from the Python `logging` module (backend internals)
  - client.log  : errors POSTed from the browser via /logs/client

Both rotate hourly. `backupCount` == retention_hours, so e.g. 24 keeps the last
24 hourly files (~1 day). Default is read from config; can be overridden by
storing `log_retention_hours` in the AppSettings table.
"""
import logging
import os
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Optional

from .config import settings as app_settings

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
APP_LOG = LOG_DIR / "app.log"
CLIENT_LOG = LOG_DIR / "client.log"

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s — %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# Marker used to find handlers we own when reconfiguring at runtime.
_HANDLER_TAG = "_newsportal_managed"


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


def _make_rotating_handler(path: Path, retention_hours: int) -> TimedRotatingFileHandler:
    handler = TimedRotatingFileHandler(
        filename=path,
        when="H",
        interval=1,
        backupCount=retention_hours,
        utc=False,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter(_FORMAT, _DATE_FORMAT))
    setattr(handler, _HANDLER_TAG, True)
    return handler


def configure_logging(db=None) -> None:
    """Install / reinstall our file handlers on the root + uvicorn loggers."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    retention = _resolve_retention_hours(db)
    level = _resolve_log_level(db)

    # Remove previously installed handlers (idempotent reconfigure)
    for logger_name in ("", "uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(logger_name)
        for h in list(lg.handlers):
            if getattr(h, _HANDLER_TAG, False):
                lg.removeHandler(h)
                try: h.close()
                except Exception: pass

    app_handler = _make_rotating_handler(APP_LOG, retention)
    app_handler.setLevel(level)

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(app_handler)

    # Uvicorn writes via its own loggers — attach the same file so request logs land too.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        ulg = logging.getLogger(name)
        ulg.addHandler(_make_rotating_handler(APP_LOG, retention))
        ulg.setLevel(level)


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
        if not (p.name.startswith("app.log") or p.name.startswith("client.log")):
            continue
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except Exception:
            pass
    return removed
