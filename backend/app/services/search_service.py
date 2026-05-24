import asyncio
import hashlib
import logging
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Article

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    # Many bot filters key off these — quiet defaults a real Chrome would send.
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Not(A:Brand";v="24", "Chromium";v="124", "Google Chrome";v="124"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _url_hash(url: str) -> str:
    normalized = url.strip().lower().split("?")[0].rstrip("/")
    return hashlib.sha256(normalized.encode()).hexdigest()


def _title_hash(title: str) -> str:
    return hashlib.sha256(title.lower().strip().encode()).hexdigest()


def _extract_content(html: str, url: str) -> dict:
    """Parse HTML and extract article metadata and content."""
    soup = BeautifulSoup(html, "lxml")

    # Remove noise
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "ads",
                     "noscript", "iframe", "form"]):
        tag.decompose()

    # Title
    title = None
    og_title = soup.find("meta", property="og:title")
    if og_title:
        title = og_title.get("content", "").strip()
    if not title:
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text(strip=True)
    if not title:
        h1 = soup.find("h1")
        if h1:
            title = h1.get_text(strip=True)

    # Description / summary
    description = None
    og_desc = soup.find("meta", property="og:description")
    if og_desc:
        description = og_desc.get("content", "").strip()
    if not description:
        meta_desc = soup.find("meta", attrs={"name": "description"})
        if meta_desc:
            description = meta_desc.get("content", "").strip()

    # Image
    image_url = None
    og_img = soup.find("meta", property="og:image")
    if og_img:
        image_url = og_img.get("content", "").strip()

    # Author
    author = None
    for sel in [
        {"name": "author"},
        {"property": "article:author"},
        {"name": "byl"},
    ]:
        meta = soup.find("meta", attrs=sel)
        if meta:
            author = meta.get("content", "").strip()
            break
    if not author:
        author_tag = soup.find(class_=lambda c: c and "author" in c.lower())
        if author_tag:
            author = author_tag.get_text(strip=True)[:256]

    # Published date
    published_at = None
    for sel in [
        {"property": "article:published_time"},
        {"name": "publish_date"},
        {"name": "date"},
        {"itemprop": "datePublished"},
    ]:
        meta = soup.find("meta", attrs=sel)
        if meta:
            raw_date = meta.get("content", "")
            try:
                published_at = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                break
            except (ValueError, AttributeError):
                pass

    # Main content
    content = ""
    candidates = soup.find_all(["article", "main"])
    if candidates:
        content = " ".join(c.get_text(separator=" ", strip=True) for c in candidates)
    if not content:
        # Fallback: all paragraphs
        paras = soup.find_all("p")
        content = " ".join(p.get_text(strip=True) for p in paras if len(p.get_text(strip=True)) > 40)

    # Clean up whitespace
    content = " ".join(content.split())[:15000]

    # Source from domain
    try:
        source = urlparse(url).netloc.replace("www.", "")
    except Exception:
        source = ""

    return {
        "title": title,
        "description": description,
        "image_url": image_url,
        "author": author,
        "published_at": published_at,
        "content": content,
        "source": source,
    }


# ── Core fetch ────────────────────────────────────────────────────────────────

async def fetch_url(url: str) -> dict:
    """Fetch a URL and return extracted content dict.

    Sends browser-like headers. If we get a 403/406, retries once with a Referer
    pointing at the site's own root, which placates a surprising number of WAFs.
    """
    headers = {**_HEADERS}
    parsed = urlparse(url)
    referer = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else None

    async with httpx.AsyncClient(
        headers=headers,
        follow_redirects=True,
        timeout=25.0,
        http2=False,
    ) as client:
        try:
            response = await client.get(url)
            if response.status_code in (403, 406, 429) and referer:
                # Retry with site-internal Referer — many WAFs (Akamai, Cloudflare bot mgr)
                # let through requests that look like in-site navigation.
                retry_headers = {"Referer": referer, "Sec-Fetch-Site": "same-origin"}
                response = await client.get(url, headers=retry_headers)
            response.raise_for_status()
            extracted = _extract_content(response.text, url)
            extracted["url"] = url
            extracted["status"] = "ok"
            return extracted
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            reason = {
                401: "site requires login",
                403: "site blocked the request (anti-bot or paywall)",
                404: "page not found",
                406: "site rejected the request format",
                429: "rate-limited by the site",
            }.get(code, f"HTTP {code}")
            return {"url": url, "status": "error", "error": reason}
        except httpx.TimeoutException:
            return {"url": url, "status": "error", "error": "request timed out"}
        except Exception as exc:
            return {"url": url, "status": "error", "error": str(exc)}


async def fetch_urls_concurrently(urls: list) -> list:
    """Fetch multiple URLs with a concurrency limit of 5."""
    semaphore = asyncio.Semaphore(5)

    async def _guarded_fetch(url):
        async with semaphore:
            return await fetch_url(url)

    tasks = [_guarded_fetch(url) for url in urls]
    return await asyncio.gather(*tasks)


# ── Google Search ─────────────────────────────────────────────────────────────

async def google_search(query: str, date_restrict: str = None, num: int = 10) -> list:
    """Call Google Custom Search API and return structured results."""
    api_key = settings.google_search_api_key
    cx = settings.google_search_cx

    # Try reading from DB if settings object doesn't have them
    if not api_key or not cx:
        logger.warning("Google Search API key or CX not configured")
        return []

    params = {
        "key": api_key,
        "cx": cx,
        "q": query,
        "num": min(num, 10),
    }
    if date_restrict:
        params["dateRestrict"] = date_restrict

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.get(
                "https://www.googleapis.com/customsearch/v1",
                params=params,
            )
            response.raise_for_status()
            data = response.json()
        except Exception as exc:
            logger.error("Google Search request failed: %s", exc)
            return []

    results = []
    for item in data.get("items", []):
        pagemap = item.get("pagemap", {})
        metatags = pagemap.get("metatags", [{}])[0] if pagemap.get("metatags") else {}
        results.append({
            "title": item.get("title"),
            "url": item.get("link"),
            "snippet": item.get("snippet"),
            "source": urlparse(item.get("link", "")).netloc.replace("www.", ""),
            "published_at": metatags.get("article:published_time") or metatags.get("og:updated_time"),
        })

    return results


# ── Import URLs to DB ─────────────────────────────────────────────────────────

async def import_urls_to_db(urls: list, category: str, db: Session) -> list:
    """Fetch URLs, deduplicate, and store as Article records."""
    fetched = await fetch_urls_concurrently(urls)
    results = []

    for item in fetched:
        url = item.get("url", "")
        if item.get("status") != "ok":
            results.append({"url": url, "status": "failed", "reason": item.get("error", "fetch error")})
            continue

        hash_val = _url_hash(url)
        existing_url = db.query(Article).filter(Article.url_hash == hash_val).first()
        if existing_url:
            results.append({"url": url, "status": "duplicate", "article_id": existing_url.id})
            continue

        title = item.get("title") or ""
        if title:
            t_hash = _title_hash(title)
            existing_title = db.query(Article).filter(Article.title_hash == t_hash).first()
            if existing_title:
                results.append({"url": url, "status": "duplicate", "article_id": existing_title.id})
                continue

        try:
            article = Article(
                url=url,
                url_hash=hash_val,
                title=item.get("title"),
                title_hash=_title_hash(title) if title else None,
                source=item.get("source"),
                category=category,
                published_at=item.get("published_at"),
                content=item.get("content"),
                summary=item.get("description"),
                author=item.get("author"),
                image_url=item.get("image_url"),
                is_analyzed=False,
            )
            db.add(article)
            db.commit()
            db.refresh(article)
            results.append({"url": url, "status": "imported", "article_id": article.id})
        except Exception as exc:
            db.rollback()
            logger.error("Failed to store article from %s: %s", url, exc)
            results.append({"url": url, "status": "failed", "reason": str(exc)})

    return results
