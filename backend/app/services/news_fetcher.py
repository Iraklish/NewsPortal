"""Pulls articles from RSS feeds and NewsAPI, dedupes, persists."""
import asyncio
import logging
import socket
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import feedparser
import httpx
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Article, AppSettings, RssSource
from .dedup import is_duplicate, title_hash, url_hash

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

NEWSAPI_CATEGORY_MAP = {
    "economics": "business",
    "geopolitics": "general",
    "technology": "technology",
    "energy": "business",
    "politics": "general",
    "world_news": "general",
}


# ── RSS ──────────────────────────────────────────────────────────────────────

def _parse_feed_date(entry) -> Optional[datetime]:
    for attr in ("published_parsed", "updated_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6])
            except Exception:
                pass
    return None


def _get_image(entry) -> Optional[str]:
    media = getattr(entry, "media_content", None)
    if media and isinstance(media, list):
        for m in media:
            if isinstance(m, dict) and m.get("url"):
                return m["url"]
    for link in getattr(entry, "links", []):
        if isinstance(link, dict) and link.get("type", "").startswith("image"):
            return link.get("href")
    return None


def _strip_html(html: str) -> str:
    if not html:
        return ""
    return BeautifulSoup(html, "lxml").get_text(separator=" ", strip=True)


# ── Full-text extraction ─────────────────────────────────────────────────────

# Articles whose stored content is shorter than this are candidates for
# full-page enrichment (headline-only or brief teaser from RSS).
_CONTENT_MIN_CHARS = 500

_JUNK_KEYWORDS = {
    "ad", "ads", "advert", "advertisement", "banner", "promo", "sponsor",
    "sidebar", "widget", "comment", "social", "share", "newsletter",
    "subscribe", "popup", "modal", "cookie", "gdpr", "paywall",
    "related", "recommendation", "toolbar", "breadcrumb", "pagination",
    "footer", "header", "nav", "navigation", "menu",
}

# Semantic selectors tried in priority order
_ARTICLE_SELECTORS = (
    "[itemprop='articleBody']",
    "article",
    ".article-body", ".article-content", ".article__body", ".article__content",
    ".story-body", ".story-content", ".story__body",
    ".post-content", ".post-body", ".entry-content", ".entry-body",
    ".content-body", ".content__body", ".main-content", ".page-content",
    "#article-body", "#article-content", "#story-body", "#main-content",
    "main",
    "[role='main']",
)


def _extract_article_text(html: str) -> str:
    """Extract main article body from raw HTML via BeautifulSoup."""
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return ""

    # Remove non-content structural tags wholesale
    for tag in soup.find_all(["script", "style", "nav", "header", "footer",
                               "aside", "figcaption", "noscript", "form",
                               "button", "iframe", "svg", "menu", "figure"]):
        tag.decompose()

    # Remove elements whose class/id signals boilerplate
    for tag in soup.find_all(True):
        combined = " ".join(tag.get("class") or []) + " " + (tag.get("id") or "")
        if any(kw in combined.lower() for kw in _JUNK_KEYWORDS):
            tag.decompose()

    # Try semantic containers in priority order
    for sel in _ARTICLE_SELECTORS:
        node = soup.select_one(sel)
        if node:
            text = node.get_text(separator=" ", strip=True)
            if len(text) > 200:
                return text[:15000]

    # Fallback: collect all meaningful <p> paragraphs from <body>
    body = soup.body or soup
    paras = [
        p.get_text(" ", strip=True)
        for p in body.find_all("p")
        if len(p.get_text(strip=True)) > 40
    ]
    text = " ".join(paras)
    return text[:15000] if len(text) > 200 else ""


_ENRICH_CAP = 50  # max articles to enrich per scheduler run (prevents long event-loop blocks)


async def _enrich_articles_fulltext(article_ids: list[int], db: Session) -> None:
    """Follow article URLs for newly stored entries whose content is thin (headline/teaser only).

    Runs up to 8 concurrent HTTP fetches (HTML parsing offloaded to a thread pool so
    the async event loop stays responsive), then writes back to DB in one commit.
    Capped at _ENRICH_CAP articles per run to bound worst-case latency.
    """
    if not article_ids:
        return

    articles = db.query(Article).filter(Article.id.in_(article_ids)).all()
    thin = [a for a in articles if not a.content or len(a.content) < _CONTENT_MIN_CHARS]
    if not thin:
        return

    # Cap per-run to avoid very long scheduler cycles
    if len(thin) > _ENRICH_CAP:
        logger.info("[fetcher] full-text enrichment: capping %d → %d articles this run",
                    len(thin), _ENRICH_CAP)
        thin = thin[:_ENRICH_CAP]

    logger.info("[fetcher] full-text enrichment: %d / %d new articles have thin content",
                len(thin), len(article_ids))

    sem = asyncio.Semaphore(8)
    loop = asyncio.get_running_loop()

    async def _get(url: str) -> str:
        async with sem:
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(8.0),
                    headers={"User-Agent": _USER_AGENT},
                    follow_redirects=True,
                    max_redirects=4,
                ) as client:
                    resp = await client.get(url)
                    ct = resp.headers.get("content-type", "")
                    if "html" not in ct:
                        return ""
                    # Offload CPU-bound BeautifulSoup parsing to a thread so the
                    # event loop stays free to handle incoming API requests.
                    return await loop.run_in_executor(None, _extract_article_text, resp.text)
            except asyncio.CancelledError:
                return ""
            except Exception:
                return ""

    try:
        texts = await asyncio.gather(*[_get(a.url) for a in thin], return_exceptions=True)
    except asyncio.CancelledError:
        logger.info("[fetcher] full-text enrichment cancelled (shutdown)")
        return

    updated = 0
    for article, text in zip(thin, texts):
        if isinstance(text, str) and text:
            article.content = text
            if not article.summary:
                article.summary = text[:500]
            updated += 1

    if updated:
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("[fetcher] full-text commit failed: %s", exc)

    logger.info("[fetcher] full-text enrichment: updated %d / %d thin articles",
                updated, len(thin))


def _fetch_rss_feed(source: RssSource, db: Session) -> list[int]:
    """Parse a single RSS feed and store new entries. Returns new article IDs."""
    new_ids: list[int] = []
    url = source.url
    category = source.category

    source.last_fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    # feedparser uses urllib which honours socket.setdefaulttimeout().
    # Without a timeout a single hung server can block the entire scheduler cycle.
    _prev_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(15)
    try:
        feed = feedparser.parse(url, agent=_USER_AGENT)
    except Exception as exc:
        logger.warning("Failed to parse RSS feed %s: %s", url, exc)
        source.last_status = "error"
        source.last_error = str(exc)[:500]
        db.commit()
        return new_ids
    finally:
        socket.setdefaulttimeout(_prev_timeout)

    # ── HTTP status check ────────────────────────────────────────────────────
    http_status = getattr(feed, "status", None)
    if http_status == 304:
        # Not Modified — no new content since last conditional GET; totally normal.
        source.last_status = "ok"
        source.last_error = None
        db.commit()
        return new_ids
    elif http_status is not None and not (200 <= http_status <= 299):
        source.last_status = "error"
        source.last_error = f"HTTP {http_status}"
        # Permanent client errors — disable to stop wasting fetch cycles.
        # (5xx are server-side / transient; keep enabled and retry next cycle.)
        _PERMANENT_ERRORS = {400, 401, 403, 404, 405, 410, 451}
        if http_status in _PERMANENT_ERRORS:
            source.enabled = False
            logger.warning(
                "[fetcher] source %d disabled (%s): HTTP %d — will not retry",
                source.id, url[:80], http_status,
            )
        else:
            logger.warning(
                "[fetcher] source %d error (%s): HTTP %d — keeping enabled for retry",
                source.id, url[:80], http_status,
            )
        db.commit()
        return new_ids

    if feed.bozo and not feed.entries:
        source.last_status = "empty"
        source.last_error = "feed has no entries or could not be parsed"
        db.commit()
        return new_ids

    feed_title = feed.feed.get("title", "") if hasattr(feed, "feed") else ""
    domain = urlparse(url).netloc.replace("www.", "")
    source_label = source.name or feed_title or domain

    for entry in feed.entries:
        entry_url = entry.get("link", "").strip()
        if not entry_url:
            continue
        title = entry.get("title", "").strip()
        if is_duplicate(entry_url, title, db):
            continue

        content = ""
        if entry.get("content"):
            for c in entry.content:
                content += c.get("value", "")
        if not content:
            content = entry.get("summary", "")
        content = _strip_html(content)

        try:
            article = Article(
                url=entry_url,
                url_hash=url_hash(entry_url),
                title=title or None,
                title_hash=title_hash(title) if title else None,
                source=source_label,
                category=category,
                published_at=_parse_feed_date(entry),
                content=content[:15000] if content else None,
                summary=(entry.get("summary") or "")[:1000] or None,
                author=entry.get("author", "") or None,
                image_url=_get_image(entry),
                is_analyzed=False,
            )
            db.add(article)
            db.commit()
            db.refresh(article)
            new_ids.append(article.id)
        except Exception as exc:
            db.rollback()
            logger.warning("Failed to store entry from %s: %s", entry_url, exc)

    source.last_status = "ok"
    source.last_error = None
    db.commit()
    return new_ids


# ── NewsAPI ──────────────────────────────────────────────────────────────────

def _resolve_news_api_key(db: Session) -> str:
    row = db.query(AppSettings).filter(AppSettings.key == "news_api_key").first()
    return (row.value if row else None) or settings.news_api_key or ""


async def _fetch_newsapi_category(api_key: str, news_category: str) -> list[dict]:
    params = {
        "category": news_category,
        "language": "en",
        "pageSize": 50,
        "apiKey": api_key,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get("https://newsapi.org/v2/top-headlines", params=params)
            r.raise_for_status()
            data = r.json()
        except Exception as exc:
            logger.warning("NewsAPI request failed for %s: %s", news_category, exc)
            return []
    return data.get("articles", []) or []


def _store_newsapi_article(item: dict, category: str, db: Session) -> Optional[int]:
    article_url = (item.get("url") or "").strip()
    if not article_url:
        return None
    title = (item.get("title") or "").strip()
    if is_duplicate(article_url, title, db):
        return None

    published_at = None
    if item.get("publishedAt"):
        try:
            published_at = datetime.fromisoformat(item["publishedAt"].replace("Z", "+00:00"))
        except Exception:
            pass

    source_name = (item.get("source") or {}).get("name") or urlparse(article_url).netloc.replace("www.", "")

    try:
        article = Article(
            url=article_url,
            url_hash=url_hash(article_url),
            title=title or None,
            title_hash=title_hash(title) if title else None,
            source=source_name,
            category=category,
            published_at=published_at,
            content=(item.get("content") or "")[:15000] or None,
            summary=(item.get("description") or "")[:1000] or None,
            author=item.get("author"),
            image_url=item.get("urlToImage"),
            is_analyzed=False,
        )
        db.add(article)
        db.commit()
        db.refresh(article)
        return article.id
    except Exception as exc:
        db.rollback()
        logger.warning("Failed to store NewsAPI item %s: %s", article_url, exc)
        return None


async def _fetch_newsapi_all(db: Session) -> list[int]:
    api_key = _resolve_news_api_key(db)
    if not api_key:
        logger.info("NewsAPI key not configured; skipping NewsAPI fetch")
        return []

    new_ids: list[int] = []
    seen_categories: set[str] = set()
    for cat, news_cat in NEWSAPI_CATEGORY_MAP.items():
        # Avoid hitting the same NewsAPI category multiple times per run
        key = f"{news_cat}"
        if key in seen_categories:
            continue
        seen_categories.add(key)

        items = await _fetch_newsapi_category(api_key, news_cat)
        for item in items:
            new_id = _store_newsapi_article(item, cat, db)
            if new_id is not None:
                new_ids.append(new_id)
    return new_ids


# ── Public entry point ───────────────────────────────────────────────────────

async def fetch_all_sources(db: Session) -> list[int]:
    """Run all enabled RSS sources from DB + NewsAPI. Returns new article IDs."""
    new_ids: list[int] = []

    sources = (
        db.query(RssSource)
        .filter(RssSource.enabled.is_(True))
        .order_by(RssSource.category, RssSource.id)
        .all()
    )

    loop = asyncio.get_running_loop()
    for source in sources:
        try:
            ids = await asyncio.wait_for(
                loop.run_in_executor(None, _fetch_rss_feed, source, db),
                timeout=30.0,   # belt-and-suspenders: socket timeout (15s) fires first
            )
        except asyncio.TimeoutError:
            logger.warning("[fetcher] source %d (%s) timed out — skipping", source.id, source.url[:60])
            ids = []
        new_ids.extend(ids)

    new_ids.extend(await _fetch_newsapi_all(db))

    # Phase 2: follow article URLs to get full body for thin entries
    await _enrich_articles_fulltext(new_ids, db)

    return new_ids
