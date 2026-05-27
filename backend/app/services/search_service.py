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

async def google_search(query: str, date_restrict: str = None, num: int = 10,
                        api_key: str = None, cx: str = None) -> list:
    """Call Google Custom Search API and return structured results."""
    api_key = api_key or settings.google_search_api_key
    cx = cx or settings.google_search_cx

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


# ── DuckDuckGo Lite (paginated) ───────────────────────────────────────────────

def _ddg_parse_page(html: str, engine_tag: str = "duckduckgo") -> tuple[list[dict], dict]:
    """Parse one DDG Lite response.  Returns (results, next_page_form_data)."""
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    for link_a in soup.select("a.result-link"):
        href = link_a.get("href", "")
        title = link_a.get_text(strip=True)
        if not href or not title:
            continue
        snippet = ""
        parent_row = link_a.find_parent("tr")
        if parent_row:
            sibling = parent_row.find_next_sibling("tr")
            if sibling:
                snippet = sibling.get_text(separator=" ", strip=True)
        try:
            source = urlparse(href).netloc.replace("www.", "")
        except Exception:
            source = ""
        results.append({
            "title": title, "url": href, "snippet": snippet,
            "source": source, "published_at": None, "engine": engine_tag,
        })

    # Extract next-page hidden form fields (class="liteform")
    next_data: dict = {}
    next_form = soup.find("form", class_="liteform")
    if next_form:
        for inp in next_form.find_all("input", type="hidden"):
            name = inp.get("name", "")
            value = inp.get("value", "")
            if name:
                next_data[name] = value

    return results, next_data


async def duckduckgo_search(query: str, num: int = 30) -> list[dict]:
    """DuckDuckGo Lite — paginated, no API key needed.

    Each page returns ~10 results. Follows the next-page form tokens
    to collect up to `num` results across multiple pages (max 5 pages).
    """
    all_results: list[dict] = []
    _hdrs = {"User-Agent": _USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}

    async with httpx.AsyncClient(headers=_hdrs, follow_redirects=True, timeout=15.0) as client:
        form_data: dict = {"q": query}
        for page_num in range(1, 6):          # max 5 pages → up to ~50 results
            try:
                r = await client.post("https://lite.duckduckgo.com/lite/", data=form_data)
                r.raise_for_status()
            except Exception as exc:
                logger.warning("[ddg] page %d request failed: %s", page_num, exc)
                break

            page_results, next_data = _ddg_parse_page(r.text)
            all_results.extend(page_results)

            if len(all_results) >= num or not next_data or not page_results:
                break
            form_data = next_data   # follow the next-page form

    seen: set[str] = set()
    unique: list[dict] = []
    for r in all_results:
        url = r["url"]
        if url not in seen:
            seen.add(url)
            unique.append(r)

    logger.debug("[ddg] %d unique results for '%s'", len(unique), query[:60])
    return unique[:num]


# ── Bing Web Search API ───────────────────────────────────────────────────────

async def bing_search_api(query: str, api_key: str, num: int = 10) -> list[dict]:
    """Bing Web Search API v7 (requires key from portal.azure.com)."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://api.bing.microsoft.com/v7.0/search",
                headers={"Ocp-Apim-Subscription-Key": api_key},
                params={"q": query, "count": min(num, 50), "mkt": "en-US"},
            )
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        logger.warning("[bing-api] request failed: %s", exc)
        return []
    results: list[dict] = []
    for item in data.get("webPages", {}).get("value", []):
        url = item.get("url", "")
        results.append({
            "title": item.get("name"),
            "url": url,
            "snippet": item.get("snippet"),
            "source": urlparse(url).netloc.replace("www.", "") if url else "",
            "published_at": item.get("datePublished"),
            "engine": "bing",
        })
    return results


# ── Bing HTML scraping (paginated, no key) ────────────────────────────────────

def _bing_parse_page(html: str) -> list[dict]:
    """Parse one Bing HTML result page."""
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    _SELECTORS = [
        ("li.b_algo", "h2 a", ".b_caption p, .b_snippet p, p"),
        (".b_algo",   "h2 a", ".b_caption p, p"),
        ("#b_results > li", "h2 a", "p"),
    ]
    for container_sel, link_sel, snippet_sel in _SELECTORS:
        containers = soup.select(container_sel)
        if not containers:
            continue
        for el in containers:
            a = el.select_one(link_sel)
            if not a:
                continue
            title = a.get_text(strip=True)
            url = a.get("href", "")
            if not url or not url.startswith("http") or not title:
                continue
            snippet_el = el.select_one(snippet_sel)
            snippet = snippet_el.get_text(strip=True) if snippet_el else ""
            try:
                source = urlparse(url).netloc.replace("www.", "")
            except Exception:
                source = ""
            results.append({
                "title": title, "url": url, "snippet": snippet,
                "source": source, "published_at": None, "engine": "bing",
            })
        if results:
            break
    return results


async def bing_html_search(query: str, num: int = 30) -> list[dict]:
    """Bing HTML scraping — paginated, no API key needed.

    Fetches up to 5 pages concurrently (each page = 10 results → up to 50 total).
    """
    pages_needed = min(5, (num + 9) // 10)
    offsets = [1 + i * 10 for i in range(pages_needed)]

    _hdrs = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
    }

    async def _fetch_page(first: int) -> list[dict]:
        try:
            async with httpx.AsyncClient(headers=_hdrs, follow_redirects=True, timeout=15.0) as client:
                r = await client.get(
                    "https://www.bing.com/search",
                    params={"q": query, "first": first, "count": 10, "setlang": "en"},
                )
                r.raise_for_status()
                return _bing_parse_page(r.text)
        except Exception as exc:
            logger.warning("[bing-html] page first=%d failed: %s", first, exc)
            return []

    page_lists = await asyncio.gather(*[_fetch_page(o) for o in offsets])

    seen: set[str] = set()
    all_results: list[dict] = []
    for page in page_lists:
        for item in page:
            if item["url"] not in seen:
                seen.add(item["url"])
                all_results.append(item)

    logger.debug("[bing-html] %d unique results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Google HTML scraping (best-effort, may be blocked) ───────────────────────

def _google_parse_page(html: str) -> list[dict]:
    """Parse Google Search result HTML.

    Google's HTML layout changes frequently — we try multiple strategies.
    """
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    # Strategy 1: Modern Google — div[data-sokoban-container] or div.g
    for container_sel in ("div[data-sokoban-container]", "div.g", "div.MjjYud"):
        for container in soup.select(container_sel):
            a_tags = container.find_all("a", href=True)
            for a in a_tags:
                href = a.get("href", "")
                if not href.startswith("http") or href in seen:
                    continue
                # Must have an h3 nearby to be a search result
                h3 = a.find("h3") or container.find("h3")
                if not h3:
                    continue
                title = h3.get_text(strip=True)
                if not title:
                    continue
                snippet = ""
                for cls in ("VwiC3b", "st", "aCOpRe", "s"):
                    el = container.select_one(f".{cls}")
                    if el:
                        snippet = el.get_text(strip=True)
                        break
                try:
                    source = urlparse(href).netloc.replace("www.", "")
                except Exception:
                    source = ""
                seen.add(href)
                results.append({
                    "title": title, "url": href, "snippet": snippet,
                    "source": source, "published_at": None, "engine": "google",
                })
                break
        if results:
            break

    # Strategy 2: h3-based fallback for any layout
    if not results:
        for h3 in soup.find_all("h3"):
            a = h3.find_parent("a") or h3.find("a")
            if not a:
                continue
            href = a.get("href", "")
            if not href.startswith("http") or href in seen:
                continue
            title = h3.get_text(strip=True)
            if not title:
                continue
            # Walk up to find a snippet
            snippet = ""
            parent = h3.find_parent("div")
            if parent:
                for span in parent.find_all("span"):
                    text = span.get_text(strip=True)
                    if len(text) > 50 and text != title:
                        snippet = text[:300]
                        break
            try:
                source = urlparse(href).netloc.replace("www.", "")
            except Exception:
                source = ""
            seen.add(href)
            results.append({
                "title": title, "url": href, "snippet": snippet,
                "source": source, "published_at": None, "engine": "google",
            })

    return results


async def google_html_search(query: str, num: int = 20) -> list[dict]:
    """Google HTML scraping — best-effort, no API key needed.

    May be blocked by CAPTCHA; returns empty list gracefully when detected.
    Fetches up to 3 pages (10 results each) concurrently.
    """
    pages_needed = min(3, (num + 9) // 10)
    offsets = [i * 10 for i in range(pages_needed)]

    _hdrs = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
        "Upgrade-Insecure-Requests": "1",
    }

    async def _fetch_page(start: int) -> list[dict]:
        try:
            async with httpx.AsyncClient(headers=_hdrs, follow_redirects=True, timeout=15.0) as client:
                r = await client.get(
                    "https://www.google.com/search",
                    params={"q": query, "start": start, "num": 10, "hl": "en"},
                )
                # Google returns 200 even for CAPTCHA pages
                if "captcha" in r.text.lower() or "unusual traffic" in r.text.lower():
                    logger.warning("[google-html] CAPTCHA detected for '%s'", query[:60])
                    return []
                return _google_parse_page(r.text)
        except Exception as exc:
            logger.warning("[google-html] page start=%d failed: %s", start, exc)
            return []

    page_lists = await asyncio.gather(*[_fetch_page(o) for o in offsets])

    seen: set[str] = set()
    all_results: list[dict] = []
    for page in page_lists:
        for item in page:
            if item["url"] not in seen:
                seen.add(item["url"])
                all_results.append(item)

    logger.debug("[google-html] %d unique results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Full parallel search (all engines combined) ───────────────────────────────

async def full_web_search(query: str, num: int = 50) -> dict:
    """Run DuckDuckGo, Bing HTML, and Google HTML in parallel.

    Merges and deduplicates results from all three engines.
    Returns a dict with 'results', 'total', and per-engine counts.
    """
    per_engine = max(num // 2, 20)

    ddg_task   = duckduckgo_search(query, num=per_engine)
    bing_task  = bing_html_search(query, num=per_engine)
    goog_task  = google_html_search(query, num=per_engine // 2)

    ddg_res, bing_res, goog_res = await asyncio.gather(
        ddg_task, bing_task, goog_task, return_exceptions=True,
    )

    # Safely unwrap (gather returns Exception objects when return_exceptions=True)
    def _safe(r: object) -> list[dict]:
        if isinstance(r, Exception):
            logger.warning("[full_search] engine error: %s", r)
            return []
        return r or []

    ddg_res  = _safe(ddg_res)
    bing_res = _safe(bing_res)
    goog_res = _safe(goog_res)

    logger.info("[full_search] raw counts — DDG:%d Bing:%d Google:%d for '%s'",
                len(ddg_res), len(bing_res), len(goog_res), query[:60])

    # Merge, deduplicate by normalized URL
    seen: set[str] = set()
    merged: list[dict] = []
    for item in ddg_res + bing_res + goog_res:
        url = item.get("url", "")
        norm = url.strip().lower().rstrip("/").split("?")[0]
        if norm and norm not in seen:
            seen.add(norm)
            merged.append(item)

    return {
        "results": merged[:num],
        "total": len(merged),
        "engines": {
            "duckduckgo": len(ddg_res),
            "bing": len(bing_res),
            "google": len(goog_res),
        },
    }


# ── Multi-engine orchestrator (used by directed reports — waterfall) ──────────

async def multi_engine_search(query: str, db=None, num: int = 8) -> list[dict]:
    """Try search engines in priority order; return first non-empty result set.

    Priority:
      1. Google Custom Search API  (if google_search_api_key + google_search_cx configured)
      2. DuckDuckGo HTML           (free, no key needed)
      3. Bing Web Search API       (if bing_search_api_key configured)
      4. Bing HTML scraping        (free, last resort)
    """

    def _key(name: str) -> str:
        if db is not None:
            try:
                from ..models import AppSettings
                row = db.query(AppSettings).filter(AppSettings.key == name).first()
                if row and row.value:
                    return row.value
            except Exception:
                pass
        return getattr(settings, name, "") or ""

    short_q = query[:80]

    # 1. Google Custom Search API
    g_key = _key("google_search_api_key")
    g_cx = _key("google_search_cx")
    if g_key and g_cx:
        try:
            results = await google_search(query, num=num, api_key=g_key, cx=g_cx)
            if results:
                logger.info("[search] Google CSE: %d results for '%s'", len(results), short_q)
                return [dict(r, engine="google_cse") for r in results]
            logger.debug("[search] Google CSE: 0 results for '%s'", short_q)
        except Exception as exc:
            logger.warning("[search] Google CSE failed: %s", exc)

    # 2. DuckDuckGo
    try:
        results = await duckduckgo_search(query, num=num)
        if results:
            logger.info("[search] DuckDuckGo: %d results for '%s'", len(results), short_q)
            return results
        logger.debug("[search] DuckDuckGo: 0 results for '%s'", short_q)
    except Exception as exc:
        logger.warning("[search] DuckDuckGo failed: %s", exc)

    # 3. Bing API
    bing_key = _key("bing_search_api_key")
    if bing_key:
        try:
            results = await bing_search_api(query, bing_key, num=num)
            if results:
                logger.info("[search] Bing API: %d results for '%s'", len(results), short_q)
                return results
            logger.debug("[search] Bing API: 0 results for '%s'", short_q)
        except Exception as exc:
            logger.warning("[search] Bing API failed: %s", exc)

    # 4. Bing HTML
    try:
        results = await bing_html_search(query, num=num)
        if results:
            logger.info("[search] Bing HTML: %d results for '%s'", len(results), short_q)
            return results
        logger.debug("[search] Bing HTML: 0 results for '%s'", short_q)
    except Exception as exc:
        logger.warning("[search] Bing HTML failed: %s", exc)

    logger.warning("[search] all engines returned 0 results for '%s'", short_q)
    return []


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
