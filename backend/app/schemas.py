from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel


# ── Article ──────────────────────────────────────────────────────────────────

class ArticleOut(BaseModel):
    id: int
    url: str
    url_hash: Optional[str] = None
    title: Optional[str] = None
    title_hash: Optional[str] = None
    source: Optional[str] = None
    category: Optional[str] = None
    published_at: Optional[datetime] = None
    fetched_at: Optional[datetime] = None
    content: Optional[str] = None
    summary: Optional[str] = None
    author: Optional[str] = None
    image_url: Optional[str] = None
    is_analyzed: bool = False

    class Config:
        from_attributes = True


# ── Analysis ─────────────────────────────────────────────────────────────────

class AnalysisOut(BaseModel):
    id: int
    article_id: Optional[int] = None
    created_at: Optional[datetime] = None
    focus: Optional[str] = None
    model_used: Optional[str] = None
    summary: Optional[str] = None
    impact_type: Optional[str] = None  # highly_positive|positive|neutral|negative|highly_negative
    economic_impact: Optional[str] = None
    market_analysis: Optional[str] = None
    geopolitical_factors: Optional[str] = None
    risk_assessment: Optional[str] = None
    opportunities: Optional[str] = None
    prognosis_short: Optional[str] = None
    prognosis_long: Optional[str] = None
    key_indicators: Optional[List[str]] = None
    affected_sectors: Optional[List[str]] = None
    affected_regions: Optional[List[str]] = None
    categories: Optional[Dict[str, Any]] = None
    confidence_score: Optional[float] = None

    class Config:
        from_attributes = True


# ── StockAnalysis ─────────────────────────────────────────────────────────────

class StockAnalysisOut(BaseModel):
    id: int
    ticker: str
    company_name: Optional[str] = None
    created_at: Optional[datetime] = None
    price: Optional[float] = None
    change_pct: Optional[float] = None
    market_cap: Optional[float] = None
    sector: Optional[str] = None
    summary: Optional[str] = None
    technical_summary: Optional[str] = None
    news_impact: Optional[str] = None
    prognosis_short: Optional[str] = None
    prognosis_long: Optional[str] = None
    impact_type: Optional[str] = None
    risk_level: Optional[str] = None
    confidence_score: Optional[float] = None
    key_levels: Optional[Dict[str, Any]] = None
    catalysts: Optional[List[str]] = None
    model_used: Optional[str] = None
    related_article_ids: Optional[List[int]] = None
    price_history: Optional[List[Dict[str, Any]]] = None
    quote_snapshot: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# ── Chat ──────────────────────────────────────────────────────────────────────

class ChatMessageIn(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessageIn] = []
    use_web: bool = False  # if True, run a live web search and answer with citations
    web_query: Optional[str] = None  # explicit query (otherwise inferred from message)


class ArticleAskRequest(BaseModel):
    question: str
    history: List[ChatMessageIn] = []


class ReportAskRequest(BaseModel):
    question: str
    history: List[ChatMessageIn] = []


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    anthropic_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    custom_ai_endpoint: Optional[str] = None
    custom_ai_api_key: Optional[str] = None
    custom_ai_model: Optional[str] = None
    fred_api_key: Optional[str] = None
    alpha_vantage_api_key: Optional[str] = None
    polygon_api_key: Optional[str] = None
    google_search_api_key: Optional[str] = None
    google_search_cx: Optional[str] = None
    bing_search_api_key: Optional[str] = None
    news_api_key: Optional[str] = None
    telegram_api_id: Optional[str] = None
    telegram_api_hash: Optional[str] = None
    telegram_phone: Optional[str] = None
    default_ai_provider: Optional[str] = None
    default_ai_model: Optional[str] = None
    chat_system_prompt: Optional[str] = None
    ask_system_prompt: Optional[str] = None
    directed_report_system_prompt: Optional[str] = None
    auto_analyze_enabled: Optional[bool] = None
    fetch_interval_minutes: Optional[int] = None


class KeyStatus(BaseModel):
    has_key: bool
    provider: str


class AppSettingsOut(BaseModel):
    anthropic_api_key: KeyStatus
    openai_api_key: KeyStatus
    gemini_api_key: KeyStatus
    deepseek_api_key: KeyStatus
    custom_ai_api_key: KeyStatus
    fred_api_key: KeyStatus
    alpha_vantage_api_key: KeyStatus
    polygon_api_key: KeyStatus
    google_search_api_key: KeyStatus
    google_search_cx: KeyStatus
    bing_search_api_key: KeyStatus
    news_api_key: KeyStatus
    telegram_api_id: KeyStatus
    telegram_api_hash: KeyStatus
    telegram_phone: KeyStatus
    default_ai_provider: str
    default_ai_model: str
    custom_ai_endpoint: Optional[str] = None
    custom_ai_model: Optional[str] = None
    chat_system_prompt: str
    ask_system_prompt: str
    directed_report_system_prompt: str
    chat_system_prompt_default: str
    ask_system_prompt_default: str
    directed_report_system_prompt_default: str
    chat_system_prompt_customized: bool
    ask_system_prompt_customized: bool
    directed_report_system_prompt_customized: bool
    auto_analyze_enabled: bool
    fetch_interval_minutes: int


# ── MindMap ───────────────────────────────────────────────────────────────────

class RssSourceOut(BaseModel):
    id: int
    url: str
    category: str
    name: Optional[str] = None
    enabled: bool
    created_at: Optional[datetime] = None
    last_fetched_at: Optional[datetime] = None
    last_status: Optional[str] = None
    last_error: Optional[str] = None

    class Config:
        from_attributes = True


class RssSourceCreate(BaseModel):
    url: str
    category: str
    name: Optional[str] = None
    enabled: bool = True


class RssSourceUpdate(BaseModel):
    url: Optional[str] = None
    category: Optional[str] = None
    name: Optional[str] = None
    enabled: Optional[bool] = None


class MindMapRequest(BaseModel):
    subject: str
    aspects: List[str] = []


# ── TelegramSource ────────────────────────────────────────────────────────────

class TelegramSourceOut(BaseModel):
    id: int
    channel_id: str
    name: Optional[str] = None
    enabled: bool
    lookback_hours: int
    created_at: Optional[datetime] = None
    last_fetched_at: Optional[datetime] = None
    last_status: Optional[str] = None
    last_error: Optional[str] = None

    class Config:
        from_attributes = True


class TelegramSourceCreate(BaseModel):
    channel_id: str            # numeric ID (negative int as string) or @username
    name: Optional[str] = None
    enabled: bool = True
    lookback_hours: int = 1


class TelegramSourceUpdate(BaseModel):
    channel_id: Optional[str] = None
    name: Optional[str] = None
    enabled: Optional[bool] = None
    lookback_hours: Optional[int] = None


class MindMapOut(BaseModel):
    id: int
    subject: str
    created_at: Optional[datetime] = None
    aspects: Optional[List[str]] = None
    model_used: Optional[str] = None
    map_data: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# ── Directed Analysis ─────────────────────────────────────────────────────────

class DirectedAnalysisRequest(BaseModel):
    focus: str
    category: Optional[str] = None
    max_articles: int = 10


class DirectedReportRequest(BaseModel):
    focus: str
    include_web: bool = True          # AI-native grounding (Gemini / Anthropic)
    include_web_search: bool = False  # Explicit multi-engine search (Google/DDG/Bing)
    time_window_hours: int = 24  # default: last 24h. Presets: 24, 48, 168 (1w), 336 (2w), 720 (1m)
    max_web_results: int = 6
    fetch_web_content: bool = False  # if true, downloads full page text for top web results (slow)


class DirectedReportRef(BaseModel):
    kind: str  # 'db' | 'web'
    title: Optional[str] = None
    url: Optional[str] = None
    source: Optional[str] = None
    published_at: Optional[str] = None
    snippet: Optional[str] = None


class DirectedReportOut(BaseModel):
    id: int
    focus: str
    created_at: Optional[datetime] = None
    model_used: Optional[str] = None
    headline: Optional[str] = None
    executive_summary: Optional[str] = None
    key_developments: List[str] = []
    economic_impact: Optional[str] = None
    market_impact: Optional[str] = None
    geopolitical_impact: Optional[str] = None
    sector_impact: Dict[str, Any] = {}
    risk_assessment: Optional[str] = None
    opportunities: Optional[str] = None
    contrarian_views: Optional[str] = None
    prognosis_short: Optional[str] = None
    prognosis_long: Optional[str] = None
    signals_to_watch: List[str] = []
    confidence_score: Optional[float] = None
    impact_type: Optional[str] = None
    references: List[DirectedReportRef] = []
    db_article_count: int = 0
    web_result_count: int = 0

    class Config:
        from_attributes = True


# ── Search ────────────────────────────────────────────────────────────────────

class GoogleSearchResult(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    snippet: Optional[str] = None
    source: Optional[str] = None
    published_at: Optional[str] = None


class GoogleSearchResponse(BaseModel):
    results: List[GoogleSearchResult] = []
    total: int = 0


class ImportRequest(BaseModel):
    urls: List[str]
    category: str = "imported"


class FetchUrlRequest(BaseModel):
    url: str


# ── Stocks ────────────────────────────────────────────────────────────────────

class StockSearchResult(BaseModel):
    ticker: str
    name: Optional[str] = None
    exchange: Optional[str] = None
    type: Optional[str] = None


class StockQuote(BaseModel):
    ticker: str
    company_name: Optional[str] = None
    price: Optional[float] = None
    change: Optional[float] = None
    change_pct: Optional[float] = None
    market_cap: Optional[float] = None
    sector: Optional[str] = None
    pe_ratio: Optional[float] = None
    week_52_high: Optional[float] = None
    week_52_low: Optional[float] = None
    volume: Optional[int] = None
    avg_volume: Optional[int] = None
    currency: Optional[str] = None
