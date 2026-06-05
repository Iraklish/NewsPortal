import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from ..config import DEFAULT_STOCK_SYSTEM_PROMPT
from ..models import Article, AppSettings, StockAnalysis
from .ai_client import call_ai, call_ai_grounded, get_current_ai_settings

logger = logging.getLogger(__name__)


def _get_stock_prompt(db: Session) -> str:
    row = db.query(AppSettings).filter(AppSettings.key == "stock_system_prompt").first()
    if row and row.value and row.value.strip():
        return row.value
    return DEFAULT_STOCK_SYSTEM_PROMPT


# ── yfinance wrappers ─────────────────────────────────────────────────────────

def _sync_get_quote(ticker: str) -> dict:
    import yfinance as yf
    t = yf.Ticker(ticker)
    info = t.info or {}
    fast = t.fast_info or {}

    def safe(key, default=None):
        try:
            val = info.get(key)
            return val if val is not None else default
        except Exception:
            return default

    def fast_safe(attr, default=None):
        try:
            val = getattr(fast, attr, None)
            return val if val is not None else default
        except Exception:
            return default

    price = fast_safe("last_price") or safe("currentPrice") or safe("regularMarketPrice")
    prev_close = fast_safe("previous_close") or safe("previousClose") or safe("regularMarketPreviousClose")
    change = None
    change_pct = None
    if price is not None and prev_close is not None and prev_close != 0:
        change = price - prev_close
        change_pct = (change / prev_close) * 100

    return {
        "ticker": ticker.upper(),
        "company_name": safe("longName") or safe("shortName"),
        "price": price,
        "change": change,
        "change_pct": change_pct,
        "market_cap": fast_safe("market_cap") or safe("marketCap"),
        "sector": safe("sector"),
        "industry": safe("industry"),
        "pe_ratio": safe("trailingPE") or safe("forwardPE"),
        "week_52_high": fast_safe("year_high") or safe("fiftyTwoWeekHigh"),
        "week_52_low": fast_safe("year_low") or safe("fiftyTwoWeekLow"),
        "volume": fast_safe("three_month_average_volume") and safe("regularMarketVolume"),
        "avg_volume": safe("averageVolume") or safe("averageVolume10days"),
        "currency": safe("currency", "USD"),
        "exchange": safe("exchange"),
        "beta": safe("beta"),
        "dividend_yield": safe("dividendYield"),
        "eps": safe("trailingEps"),
        "book_value": safe("bookValue"),
        "price_to_book": safe("priceToBook"),
        "profit_margins": safe("profitMargins"),
        "revenue_growth": safe("revenueGrowth"),
        "earnings_growth": safe("earningsGrowth"),
        "description": safe("longBusinessSummary"),
    }


def _sync_get_history(ticker: str, period: str = "1mo") -> list:
    import yfinance as yf
    t = yf.Ticker(ticker)
    hist = t.history(period=period)
    records = []
    for ts, row in hist.iterrows():
        records.append({
            "date": ts.strftime("%Y-%m-%d"),
            "open": round(float(row["Open"]), 4) if row["Open"] else None,
            "high": round(float(row["High"]), 4) if row["High"] else None,
            "low": round(float(row["Low"]), 4) if row["Low"] else None,
            "close": round(float(row["Close"]), 4) if row["Close"] else None,
            "volume": int(row["Volume"]) if row["Volume"] else None,
        })
    return records


def _sync_search_ticker(query: str) -> list:
    import yfinance as yf
    try:
        results = yf.Search(query, max_results=10)
        hits = []
        for item in (results.quotes or []):
            hits.append({
                "ticker": item.get("symbol", ""),
                "name": item.get("longname") or item.get("shortname", ""),
                "exchange": item.get("exchange", ""),
                "type": item.get("quoteType", ""),
            })
        return hits
    except Exception as exc:
        logger.warning("yfinance search failed for '%s': %s", query, exc)
        return []


# ── Public async functions ────────────────────────────────────────────────────

async def get_quote(ticker: str) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _sync_get_quote(ticker))


async def get_history(ticker: str, period: str = "1mo") -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _sync_get_history(ticker, period))


async def search_ticker(query: str) -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _sync_search_ticker(query))


_LANG_INSTRUCTIONS = {
    "Hebrew": "Hebrew (עברית)",
    "Russian": "Russian (Русский)",
    "Georgian": "Georgian (ქართული)",
    "French": "French (Français)",
    "German": "German (Deutsch)",
    "Arabic": "Arabic (العربية)",
    "Spanish": "Spanish (Español)",
}


def _language_clause(language: str) -> str:
    lang = (language or "").strip()
    if not lang or lang.lower() == "english":
        return ""
    name = _LANG_INSTRUCTIONS.get(lang, lang)
    return (
        f" Write all human-readable text field VALUES (summary, technical_summary, "
        f"news_impact, prognosis_short, prognosis_long, catalysts) in {name}. "
        f"Keep all JSON KEYS and the enum values for impact_type and risk_level in English."
    )


async def analyze_stock(
    ticker: str,
    db: Session,
    include_web: bool = False,
    include_web_search: bool = False,
    language: str = "",
) -> dict:
    """Fetch quote + price history + related news, run AI analysis, store in DB.

    include_web        → use the provider's native web grounding (Gemini/Anthropic).
    include_web_search → run an explicit multi-engine web search and feed results in.
    language           → write prose field values in this language (keys/enums stay English).
    Both grounding modes contribute reference links stored on the analysis record.
    """
    ticker = ticker.upper()

    # Gather data concurrently
    quote_task = asyncio.create_task(get_quote(ticker))
    history_task = asyncio.create_task(get_history(ticker, "1mo"))
    quote, history = await asyncio.gather(quote_task, history_task, return_exceptions=True)

    if isinstance(quote, Exception):
        logger.error("Failed to fetch quote for %s: %s", ticker, quote)
        quote = {"ticker": ticker}
    if isinstance(history, Exception):
        logger.error("Failed to fetch history for %s: %s", ticker, history)
        history = []

    # Find related articles from DB
    company_name = quote.get("company_name") or ticker
    related_articles = (
        db.query(Article)
        .filter(
            (Article.title.ilike(f"%{ticker}%")) | (Article.title.ilike(f"%{company_name}%"))
        )
        .order_by(Article.published_at.desc().nullslast())
        .limit(5)
        .all()
    )
    related_ids = [a.id for a in related_articles]

    # Build price action summary
    price_summary = ""
    if history:
        first_close = history[0].get("close") or 0
        last_close = history[-1].get("close") or 0
        highs = [r["high"] for r in history if r.get("high")]
        lows = [r["low"] for r in history if r.get("low")]
        period_high = max(highs) if highs else None
        period_low = min(lows) if lows else None
        pct_change = ((last_close - first_close) / first_close * 100) if first_close else 0
        price_summary = (
            f"30-day price action: opened at ${first_close:.2f}, "
            f"currently at ${last_close:.2f} ({pct_change:+.2f}%). "
        )
        if period_high:
            price_summary += f"Period high: ${period_high:.2f}, low: ${period_low:.2f}."

    # Build news summary
    news_summary = ""
    if related_articles:
        headlines = "\n".join(
            f"- {a.title} ({a.source or 'unknown'}, {a.published_at.date() if a.published_at else 'n/a'})"
            for a in related_articles
        )
        news_summary = f"\nRecent related news:\n{headlines}"

    # Explicit multi-engine web search (Google/DDG/Bing) — runs first if requested.
    references: list[dict] = []
    web_block = ""
    if include_web_search:
        try:
            from .search_service import multi_engine_search
            web_results = await multi_engine_search(f"{company_name} {ticker} stock news analysis", db=db, num=8)
            if web_results:
                lines = ["\n\n=== LIVE WEB SEARCH RESULTS ==="]
                for i, r in enumerate(web_results, 1):
                    lines.append(
                        f"[WEB-{i}] {r.get('title') or '(no title)'}\n"
                        f"    Source: {r.get('source') or 'web'} | {r.get('published_at') or ''}\n"
                        f"    URL: {r.get('url')}\n"
                        f"    {r.get('snippet') or ''}"
                    )
                    references.append({
                        "title": r.get("title"), "url": r.get("url"),
                        "source": r.get("source"), "snippet": r.get("snippet"),
                    })
                web_block = "\n".join(lines)
            logger.info("[stocks] web search for %s returned %d result(s)", ticker, len(web_results))
        except Exception as exc:
            logger.warning("[stocks] web search failed for %s: %s", ticker, exc)

    # Build AI prompt (system prompt configurable in Settings)
    system = _get_stock_prompt(db) + _language_clause(language)

    user = f"""Analyze the following stock and return a JSON object with exactly these fields:

{{
  "summary": "2-3 sentence overall assessment",
  "technical_summary": "technical analysis of price action",
  "news_impact": "how recent news affects the stock",
  "prognosis_short": "1-6 month price/performance outlook",
  "prognosis_long": "6-24 month outlook",
  "impact_type": "bullish | bearish | neutral | volatile",
  "risk_level": "low | medium | high | very_high",
  "confidence_score": 0.75,
  "key_levels": {{
    "support": 0.0,
    "resistance": 0.0,
    "target": 0.0,
    "stop_loss": 0.0
  }},
  "catalysts": ["catalyst 1", "catalyst 2"]
}}

Stock: {ticker}
Company: {company_name}
Sector: {quote.get("sector", "N/A")}
Industry: {quote.get("industry", "N/A")}
Current Price: ${quote.get("price", "N/A")}
Market Cap: ${quote.get("market_cap", "N/A")}
P/E Ratio: {quote.get("pe_ratio", "N/A")}
52-Week High: ${quote.get("week_52_high", "N/A")}
52-Week Low: ${quote.get("week_52_low", "N/A")}
Beta: {quote.get("beta", "N/A")}
{price_summary}
{news_summary}
{web_block}
"""

    try:
        if include_web:
            system_grounded = (
                system
                + " ADDITIONALLY: use your built-in web search to ground the analysis in the "
                "latest real-world developments, filings, analyst notes and price-moving news."
            )
            grounded = await call_ai_grounded(system=system_grounded, user=user, max_tokens=2048, db=db)
            raw = grounded.text
            for c in (grounded.citations or []):
                if c.url:
                    references.append({"title": c.title, "url": c.url, "source": None, "snippet": c.snippet})
            logger.info(
                "[stocks] AI grounding for %s used=%s, %d citation(s)",
                ticker, grounded.provider_used_grounding, len(grounded.citations or []),
            )
        else:
            raw = await call_ai(system=system, user=user, max_tokens=2048, db=db)
        import json, re
        cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1:
            cleaned = cleaned[start : end + 1]
        ai_data = json.loads(cleaned)
    except Exception as exc:
        logger.error("Stock AI analysis failed for %s: %s", ticker, exc)
        ai_data = {}

    _, model_name = await get_current_ai_settings(db)

    # De-dupe references by URL, preserving order.
    seen_urls: set[str] = set()
    deduped_refs: list[dict] = []
    for ref in references:
        u = ref.get("url")
        if u and u not in seen_urls:
            seen_urls.add(u)
            deduped_refs.append(ref)

    record = StockAnalysis(
        ticker=ticker,
        company_name=company_name,
        price=quote.get("price"),
        change_pct=quote.get("change_pct"),
        market_cap=quote.get("market_cap"),
        sector=quote.get("sector"),
        summary=ai_data.get("summary", ""),
        technical_summary=ai_data.get("technical_summary", ""),
        news_impact=ai_data.get("news_impact", ""),
        prognosis_short=ai_data.get("prognosis_short", ""),
        prognosis_long=ai_data.get("prognosis_long", ""),
        impact_type=ai_data.get("impact_type", "neutral"),
        risk_level=ai_data.get("risk_level", "medium"),
        confidence_score=float(ai_data.get("confidence_score", 0.0)),
        key_levels=ai_data.get("key_levels", {}),
        catalysts=ai_data.get("catalysts", []),
        model_used=model_name,
        related_article_ids=related_ids,
        price_history=history,
        quote_snapshot=quote,
        references=deduped_refs,
    )

    db.add(record)
    db.commit()
    db.refresh(record)

    return {
        "id": record.id,
        "ticker": record.ticker,
        "company_name": record.company_name,
        "created_at": record.created_at,
        "price": record.price,
        "change_pct": record.change_pct,
        "market_cap": record.market_cap,
        "sector": record.sector,
        "summary": record.summary,
        "technical_summary": record.technical_summary,
        "news_impact": record.news_impact,
        "prognosis_short": record.prognosis_short,
        "prognosis_long": record.prognosis_long,
        "impact_type": record.impact_type,
        "risk_level": record.risk_level,
        "confidence_score": record.confidence_score,
        "key_levels": record.key_levels,
        "catalysts": record.catalysts,
        "model_used": record.model_used,
        "related_article_ids": record.related_article_ids,
        "price_history": record.price_history,
        "quote_snapshot": record.quote_snapshot,
        "references": record.references,
    }
