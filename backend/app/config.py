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

    # AI prompt overrides (empty -> use hardcoded defaults)
    chat_system_prompt: str = ""
    ask_system_prompt: str = ""

    # Logging
    log_retention_hours: int = 24  # how many hourly log files to keep
    log_level: str = "INFO"

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


settings = Settings()
