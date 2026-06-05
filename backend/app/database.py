import json
import logging
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import settings

logger = logging.getLogger(__name__)

# Key under which we remember RSS feed URLs the user deleted on purpose, so the
# automatic seeder never resurrects them on the next restart.
RSS_TOMBSTONE_KEY = "deleted_rss_urls"

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _record):
    """Enable WAL journal mode and a generous busy timeout on every new connection.

    WAL (Write-Ahead Logging) allows concurrent readers while a writer is
    active — the default DELETE journal mode locks the entire file for every
    write, which causes "database is locked" errors when the background
    scheduler holds a write transaction during a long AI call.

    busy_timeout=30000 tells SQLite to retry for up to 30 s before giving up,
    instead of the default 5 s.  SYNCHRONOUS=NORMAL is safe with WAL and
    gives a ~2× throughput improvement over the default FULL.
    """
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=30000")  # milliseconds
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

_COLUMN_MIGRATIONS = [
    ("analyses", "focus", "VARCHAR(512)"),
    ("analyses", "model_used", "VARCHAR(128)"),
    ("analyses", "summary", "TEXT"),
    ("analyses", "impact_type", "VARCHAR(16)"),
    # tags: stored as JSON (TEXT in SQLite) — language-agnostic English topic labels
    ("articles", "tags", "TEXT DEFAULT '[]'"),
    # stock analysis grounding references (web/AI), stored as JSON
    ("stock_analyses", "grounding_references", "TEXT DEFAULT '[]'"),
]


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    _seed_rss_sources()


# ── RSS deletion tombstones ──────────────────────────────────────────────────

def get_deleted_rss_urls(db) -> set[str]:
    """Return the set of feed URLs the user has deleted on purpose."""
    from .models import AppSettings
    row = db.query(AppSettings).filter(AppSettings.key == RSS_TOMBSTONE_KEY).first()
    if not row or not row.value:
        return set()
    try:
        data = json.loads(row.value)
        return set(data) if isinstance(data, list) else set()
    except Exception:
        return set()


def add_deleted_rss_urls(db, urls) -> None:
    """Record feed URLs as intentionally deleted (merges into the existing set).

    Does NOT commit — the caller commits as part of its own transaction.
    """
    from .models import AppSettings
    new_urls = {u for u in urls if u}
    if not new_urls:
        return
    merged = get_deleted_rss_urls(db) | new_urls
    payload = json.dumps(sorted(merged))
    row = db.query(AppSettings).filter(AppSettings.key == RSS_TOMBSTONE_KEY).first()
    if row:
        row.value = payload
    else:
        db.add(AppSettings(key=RSS_TOMBSTONE_KEY, value=payload))


def clear_deleted_rss_urls(db) -> None:
    """Forget all deletion tombstones (does NOT commit)."""
    from .models import AppSettings
    row = db.query(AppSettings).filter(AppSettings.key == RSS_TOMBSTONE_KEY).first()
    if row:
        row.value = "[]"


def _seed_rss_sources():
    """Populate rss_sources table from rss_sources.RSS_FEEDS.

    Adds any feeds that are not already in the DB without touching existing rows.
    This means new categories (e.g. entertainment) are picked up automatically
    on the next server restart even on existing installations.

    Feeds the user has explicitly deleted (recorded as tombstones) are skipped so
    deletions persist across restarts instead of being resurrected here.
    """
    from .models import RssSource
    from .services.rss_sources import RSS_FEEDS

    with SessionLocal() as db:
        existing_urls: set[str] = {row.url for row in db.query(RssSource.url).all()}
        deleted_urls: set[str] = get_deleted_rss_urls(db)
        added = 0
        for category, urls in RSS_FEEDS.items():
            for url in urls:
                if url in existing_urls or url in deleted_urls:
                    continue
                existing_urls.add(url)
                db.add(RssSource(url=url, category=category, enabled=True))
                added += 1
        if added:
            db.commit()
            logger.info("Seeded %d new RSS sources", added)


def _run_migrations():
    inspector = inspect(engine)
    with engine.connect() as conn:
        for table, col, col_type in _COLUMN_MIGRATIONS:
            if table not in inspector.get_table_names():
                continue
            existing = [c["name"] for c in inspector.get_columns(table)]
            if col not in existing:
                logger.info("Adding column %s.%s", table, col)
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
        conn.commit()
