import logging
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import settings

logger = logging.getLogger(__name__)

engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

_COLUMN_MIGRATIONS = [
    ("analyses", "focus", "VARCHAR(512)"),
    ("analyses", "model_used", "VARCHAR(128)"),
    ("analyses", "summary", "TEXT"),
    ("analyses", "impact_type", "VARCHAR(16)"),
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


def _seed_rss_sources():
    """Populate rss_sources table from rss_sources.RSS_FEEDS if empty."""
    from .models import RssSource
    from .services.rss_sources import RSS_FEEDS

    with SessionLocal() as db:
        if db.query(RssSource).count() > 0:
            return
        seen: set[str] = set()
        added = 0
        for category, urls in RSS_FEEDS.items():
            for url in urls:
                if url in seen:
                    continue
                seen.add(url)
                db.add(RssSource(url=url, category=category, enabled=True))
                added += 1
        db.commit()
        logger.info("Seeded %d RSS sources", added)


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
