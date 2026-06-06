from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///./economic_review.db"
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    gemini_api_key: str = ""
    deepseek_api_key: str = ""
    custom_ai_endpoint: str = ""
    custom_ai_api_key: str = ""
    custom_ai_model: str = ""
    fred_api_key: str = ""
    alpha_vantage_api_key: str = ""
    polygon_api_key: str = ""
    google_search_api_key: str = ""
    google_search_cx: str = ""
    bing_search_api_key: str = ""
    default_ai_provider: str = "anthropic"
    default_ai_model: str = "claude-sonnet-4-6"

    # News ingestion
    news_api_key: str = ""
    fetch_interval_minutes: int = 30
    retention_days: int = 365
    max_auto_analyze_per_run: int = 25
    auto_analyze_enabled: bool = True
    auto_tag_interval_minutes: int = 10  # secondary scheduler: backfill tags for untagged articles

    # AI prompt overrides (empty -> use hardcoded defaults)
    chat_system_prompt: str = ""
    ask_system_prompt: str = ""
    directed_report_system_prompt: str = ""

    # Logging
    log_retention_hours: int = 24  # how many hourly log files to keep
    log_level: str = "INFO"

    # WhatsApp bridge (Node sidecar — see whatsapp-bridge/)
    whatsapp_bridge_url: str = "http://127.0.0.1:8765"
    whatsapp_bridge_token: str = ""

    # Authentication
    auth_token_expire_minutes: int = 60 * 24 * 7   # access-token lifetime (7 days)
    initial_admin_username: str = "admin"          # seeded on first run if no users exist
    initial_admin_password: str = ""               # if empty, a random one is generated + logged

    class Config:
        env_file = ".env"
        extra = "allow"


DEFAULT_CHAT_SYSTEM_PROMPT = (
    "You are an expert economic and financial analyst assistant. "
    "Answer questions based on the recent news analyses provided as context. "
    "Provide insightful, data-driven responses. "
    "Reference specific articles and analyses when relevant."
)

DEFAULT_ASK_SYSTEM_PROMPT = (
    "You are an expert economic and geopolitical analyst. "
    "Answer the user's question grounded strictly in the article below "
    "(and any prior AI analyses of it). If the article does not contain the answer, say so. "
    "Be concrete: cite numbers, dates, named actors when relevant."
)

DEFAULT_DIRECTED_REPORT_SYSTEM_PROMPT = (
    "You are a senior economic, financial and geopolitical analyst. "
    "Synthesize a coherent, evidence-grounded report from multiple sources. "
    "Cite specific items from the context by their [DB-N] / [WEB-N] tags inline where appropriate. "
    "Be concrete: use numbers, named players, dates, sectors. Avoid hedging fluff. "
    "Acknowledge contradictions between sources rather than glossing over them. "
    "Respond with ONLY a single valid JSON object — no markdown, no surrounding prose."
)

# Entertainment broad-filter keywords (used to match entertainment content across
# all categories by article tag or title). Curated to be precise: short ambiguous
# substrings that produce false positives (e.g. "band"→husband, "actor"→factor,
# "culture"→agriculture, "marvel"→marvelous) are deliberately excluded.
DEFAULT_ENTERTAINMENT_KEYWORDS: list[str] = [
    "hollywood", "celebrity", "celebrities", "box office", "red carpet",
    "blockbuster", "grammy", "grammys", "oscar", "oscars", "emmy", "emmys",
    "golden globe", "academy award", "movie premiere", "film festival",
    "music album", "concert tour", "tv series", "tv show", "streaming series",
    "music video", "netflix series", "movie", "film", "music video",
]

# Comma-joined string form, used as the editable default in Settings.
DEFAULT_ENTERTAINMENT_KEYWORDS_STR = ", ".join(
    dict.fromkeys(DEFAULT_ENTERTAINMENT_KEYWORDS)  # de-dupe, preserve order
)


# The user-message prompt sent by the per-article "Summarize" button on the
# News page. Editable in Settings (key "article_summarize_prompt"); a language
# instruction is appended automatically when a non-English language is chosen.
DEFAULT_ARTICLE_SUMMARIZE_PROMPT = (
    "Please provide a concise summary of this article. Cover: the main topic, "
    "key facts or figures, who is involved, why it matters, and any immediate implications."
)


# Predefined focus-topic presets for the Analysis & Prognosis page. Editable
# (persisted in AppSettings under "analysis_focus_presets"); capped at 20.
DEFAULT_ANALYSIS_FOCUS_PRESETS: list[str] = [
    "Impact of Iran sanctions on global oil markets and energy security",
    "Federal Reserve interest rate outlook and market implications",
    "Israel–Middle East conflict economic and geopolitical impact",
    "AI sector investment trends and key players",
    "China economic slowdown and global supply chains",
    "European energy security and natural gas markets",
]


# Predefined "extra instructions" presets for the Article Summary page. Editable
# (persisted in AppSettings under "summary_presets"); capped at 20.
DEFAULT_SUMMARY_PRESETS: list[str] = [
    "Focus on Marvel / entertainment news",
    "Group results by region",
    "Respond in Hebrew",
    "Highlight any market-moving events",
]


# Quick-pick tickers shown as chips on the Stock Reviews page. User-editable
# (persisted in AppSettings under "quick_tickers"); this is the seed default.
DEFAULT_QUICK_TICKERS: list[str] = [
    "AAPL", "TSLA", "NVDA", "SPY", "BTC-USD", "MSFT",
    "AMZN", "ILS=X", "WIX", "VST", "MSTU", "TWLO",
]


DEFAULT_IMAGE_ANALYSIS_PROMPT = (
    "You are a visual analyst. Describe and analyze the image in the context of the news "
    "post it accompanies. Note what is shown, any text/figures/logos/people visible, what it "
    "implies, and whether it supports or adds to the post. Be concrete and concise."
)

DEFAULT_LINK_ANALYSIS_PROMPT = (
    "You are an expert news analyst. Summarize and analyze the linked article: the key facts, "
    "who is involved, why it matters, and its economic/market/geopolitical implications. Be "
    "concrete with numbers, names and dates."
)


DEFAULT_STOCK_SYSTEM_PROMPT = (
    "You are an expert stock market and economic analyst. "
    "Analyze the given stock data and return a JSON response only — no markdown, no commentary."
)


DEFAULT_SUMMARY_SYSTEM_PROMPT = """\
Summarize the following messages. Except weather, humor and advertisements, organize the summary \
by breaking down all subjects and topics discussed. For each subject, list relevant topics and \
provide a detailed explanation of key points, insights, or decisions mentioned.

Structure the summary in this format:

**Subject-Tagged Format (Strict Adherence Required):**

You **must strictly adhere** to the following format

**Subject 1**: [Brief overview of the subject] , sources
  - [Detailed description of points discussed]
  - [Detailed description of points discussed]
  - [Detailed description of points discussed]

**Subject 2**: [Brief overview of the subject] , sources
  - [Detailed description of points discussed]
  - [Detailed description of points discussed]
  - [Detailed description of points discussed]\
"""


settings = Settings()
