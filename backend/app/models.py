from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, JSON, String, Text
from .database import Base


def _utcnow() -> datetime:
    """Return current UTC time as a tz-naive datetime (SQLite/SQLAlchemy compatible)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Article(Base):
    __tablename__ = "articles"
    id = Column(Integer, primary_key=True, index=True)
    url = Column(String(2048), nullable=False)
    url_hash = Column(String(64), unique=True, index=True)
    title = Column(String(512))
    title_hash = Column(String(64), index=True)
    source = Column(String(256))
    category = Column(String(128))
    published_at = Column(DateTime, index=True)
    fetched_at = Column(DateTime, default=_utcnow)
    content = Column(Text)
    summary = Column(Text)
    author = Column(String(256))
    image_url = Column(String(2048))
    is_analyzed = Column(Boolean, default=False)
    tags = Column(JSON, default=list)   # list[str] — language-agnostic English topic tags


class Analysis(Base):
    __tablename__ = "analyses"
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, index=True)
    created_at = Column(DateTime, default=_utcnow, index=True)
    focus = Column(String(512))
    model_used = Column(String(128))
    summary = Column(Text)
    impact_type = Column(String(16))
    economic_impact = Column(Text)
    market_analysis = Column(Text)
    geopolitical_factors = Column(Text)
    risk_assessment = Column(Text)
    opportunities = Column(Text)
    prognosis_short = Column(Text)
    prognosis_long = Column(Text)
    key_indicators = Column(JSON, default=list)
    affected_sectors = Column(JSON, default=list)
    affected_regions = Column(JSON, default=list)
    categories = Column(JSON, default=dict)
    confidence_score = Column(Float)


class StockAnalysis(Base):
    __tablename__ = "stock_analyses"
    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String(16), nullable=False, index=True)
    company_name = Column(String(256))
    created_at = Column(DateTime, default=_utcnow, index=True)
    price = Column(Float)
    change_pct = Column(Float)
    market_cap = Column(Float)
    sector = Column(String(128))
    summary = Column(Text)
    technical_summary = Column(Text)
    news_impact = Column(Text)
    prognosis_short = Column(Text)
    prognosis_long = Column(Text)
    impact_type = Column(String(32))
    risk_level = Column(String(16))
    confidence_score = Column(Float)
    key_levels = Column(JSON, default=dict)
    catalysts = Column(JSON, default=list)
    model_used = Column(String(128))
    related_article_ids = Column(JSON, default=list)
    price_history = Column(JSON, default=list)
    quote_snapshot = Column(JSON, default=dict)
    # 'references' is a reserved SQL word → store under a safe column name,
    # but keep the Python attribute (and API field) as `references`.
    references = Column("grounding_references", JSON, default=list)   # [{title,url,source,snippet}]


class AppSettings(Base):
    __tablename__ = "app_settings"
    id = Column(Integer, primary_key=True)
    key = Column(String(128), unique=True, nullable=False)
    value = Column(Text)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(128), unique=True, nullable=False, index=True)
    password_hash = Column(String(256), nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    last_login_at = Column(DateTime)


class DirectedReport(Base):
    __tablename__ = "directed_reports"
    id = Column(Integer, primary_key=True, index=True)
    focus = Column(String(512), nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow, index=True)
    model_used = Column(String(128))

    headline = Column(String(512))
    executive_summary = Column(Text)
    key_developments = Column(JSON, default=list)

    economic_impact = Column(Text)
    market_impact = Column(Text)
    geopolitical_impact = Column(Text)
    sector_impact = Column(JSON, default=dict)

    risk_assessment = Column(Text)
    opportunities = Column(Text)
    contrarian_views = Column(Text)

    prognosis_short = Column(Text)
    prognosis_long = Column(Text)
    signals_to_watch = Column(JSON, default=list)

    confidence_score = Column(Float)
    impact_type = Column(String(16))  # highly_positive | positive | neutral | negative | highly_negative

    # Source provenance
    references = Column(JSON, default=list)  # [{kind: 'db'|'web', title, url, source, published_at, snippet}]
    db_article_count = Column(Integer, default=0)
    web_result_count = Column(Integer, default=0)


class TelegramSource(Base):
    __tablename__ = "telegram_sources"
    id = Column(Integer, primary_key=True, index=True)
    # channel_id can be a numeric ID (as string) or a @username / invite-slug
    channel_id = Column(String(128), unique=True, nullable=False, index=True)
    name = Column(String(256))
    enabled = Column(Boolean, default=True, nullable=False)
    lookback_hours = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    last_fetched_at = Column(DateTime)
    last_status = Column(String(32))   # ok | empty | error
    last_error = Column(Text)


class WhatsAppSource(Base):
    __tablename__ = "whatsapp_sources"
    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(String(128), unique=True, nullable=False, index=True)   # serialized chat id from the bridge
    name = Column(String(256))
    is_group = Column(Boolean, default=False, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    lookback_hours = Column(Integer, default=24, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    last_fetched_at = Column(DateTime)
    last_status = Column(String(32))   # ok | empty | error
    last_error = Column(Text)


class RssSource(Base):
    __tablename__ = "rss_sources"
    id = Column(Integer, primary_key=True, index=True)
    url = Column(String(2048), unique=True, nullable=False, index=True)
    category = Column(String(128), nullable=False, index=True)
    name = Column(String(256))
    enabled = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    last_fetched_at = Column(DateTime)
    last_status = Column(String(32))
    last_error = Column(Text)


class MindMap(Base):
    __tablename__ = "mindmaps"
    id = Column(Integer, primary_key=True, index=True)
    subject = Column(String(512), nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow, index=True)
    aspects = Column(JSON, default=list)
    model_used = Column(String(128))
    map_data = Column(JSON, default=dict)
