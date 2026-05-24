"""Log viewer + frontend error sink + retention settings."""
import logging
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..logging_config import (
    APP_LOG, CLIENT_LOG, LOG_DIR,
    configure_logging, get_client_logger, prune_old_logs, _resolve_retention_hours, _resolve_log_level,
)
from ..models import AppSettings

router = APIRouter()
logger = logging.getLogger(__name__)


def _tail_file(path: Path, n: int) -> List[str]:
    if not path.exists():
        return []
    # tail -n N implemented as a bounded deque while streaming the file
    buf: deque[str] = deque(maxlen=n)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            buf.append(line.rstrip("\n"))
    return list(buf)


@router.get("")
def list_logs(
    source: str = Query("app", pattern="^(app|client)$"),
    limit: int = Query(500, ge=1, le=10000),
    level: Optional[str] = Query(None, description="Filter to entries containing this level token (DEBUG/INFO/WARNING/ERROR)"),
    q: Optional[str] = Query(None, description="Substring filter"),
):
    """Return the last `limit` lines of either app.log or client.log."""
    path = APP_LOG if source == "app" else CLIENT_LOG
    lines = _tail_file(path, limit * 3 if (level or q) else limit)
    if level:
        token = level.strip().upper()
        lines = [ln for ln in lines if token in ln]
    if q:
        sub = q.lower()
        lines = [ln for ln in lines if sub in ln.lower()]
    lines = lines[-limit:]

    # Size info for UI footer
    size_bytes = path.stat().st_size if path.exists() else 0
    return {
        "source": source,
        "path": str(path),
        "count": len(lines),
        "size_bytes": size_bytes,
        "lines": lines,
    }


@router.get("/files")
def list_log_files():
    """Inventory of log files currently on disk."""
    if not LOG_DIR.exists():
        return {"files": [], "dir": str(LOG_DIR)}
    files = []
    for p in sorted(LOG_DIR.iterdir()):
        if not p.is_file():
            continue
        st = p.stat()
        files.append({
            "name": p.name,
            "size_bytes": st.st_size,
            "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
        })
    return {"dir": str(LOG_DIR), "files": files}


class ClientLogIn(BaseModel):
    level: str = "ERROR"            # ERROR | WARN | INFO
    message: str
    url: Optional[str] = None       # page URL where it happened
    stack: Optional[str] = None
    user_agent: Optional[str] = None
    context: Optional[dict] = None  # arbitrary extra info


@router.post("/client")
def log_client_event(body: ClientLogIn):
    """Receive a log entry from the browser. Stored in client.log."""
    parts = [
        f"[{body.level.upper():<5}]",
        f"url={body.url or '-'}",
        f"ua={(body.user_agent or '-')[:120]}",
        f"msg={body.message[:1000]}",
    ]
    if body.stack:
        parts.append(f"stack={body.stack[:2000].replace(chr(10), ' | ')}")
    if body.context:
        parts.append(f"ctx={body.context}")
    get_client_logger().info(" ".join(parts))
    return {"ok": True}


# ── Settings ──────────────────────────────────────────────────────────────────

class LogSettingsOut(BaseModel):
    log_retention_hours: int
    log_level: str


class LogSettingsUpdate(BaseModel):
    log_retention_hours: Optional[int] = None
    log_level: Optional[str] = None


_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


@router.get("/settings", response_model=LogSettingsOut)
def get_log_settings(db: Session = Depends(get_db)):
    return LogSettingsOut(
        log_retention_hours=_resolve_retention_hours(db),
        log_level=logging.getLevelName(_resolve_log_level(db)),
    )


@router.put("/settings", response_model=LogSettingsOut)
def update_log_settings(body: LogSettingsUpdate, db: Session = Depends(get_db)):
    if body.log_retention_hours is not None:
        if body.log_retention_hours < 1 or body.log_retention_hours > 24 * 90:
            raise HTTPException(status_code=422, detail="log_retention_hours must be between 1 and 2160 (90 days)")
        _upsert(db, "log_retention_hours", str(body.log_retention_hours))
    if body.log_level is not None:
        lvl = body.log_level.strip().upper()
        if lvl not in _LEVELS:
            raise HTTPException(status_code=422, detail=f"log_level must be one of {sorted(_LEVELS)}")
        _upsert(db, "log_level", lvl)
    db.commit()
    # Reconfigure handlers + prune anything now older than the new retention.
    configure_logging(db)
    pruned = prune_old_logs(_resolve_retention_hours(db))
    if pruned:
        logger.info("Pruned %d old log file(s) after retention change", pruned)
    return get_log_settings(db)


def _upsert(db: Session, key: str, value: str) -> None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSettings(key=key, value=value))


@router.delete("")
def clear_logs(source: str = Query("app", pattern="^(app|client|all)$")):
    """Truncate the chosen log file(s)."""
    targets = []
    if source in ("app", "all"): targets.append(APP_LOG)
    if source in ("client", "all"): targets.append(CLIENT_LOG)
    for p in targets:
        try:
            if p.exists():
                with open(p, "w", encoding="utf-8") as f:
                    f.write("")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to clear {p.name}: {exc}")
    return {"cleared": [str(p) for p in targets]}
