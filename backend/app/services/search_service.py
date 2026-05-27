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


# ── DuckDuckGo (ddgs package — renamed from duckduckgo_search in v8+) ─────────

async def duckduckgo_search(query: str, num: int = 50) -> list[dict]:
    """DuckDuckGo via the `ddgs` package (renamed from `duckduckgo_search` in v8+).

    `max_results=None` requests all results DDG can provide — typically 25-40.
    Run synchronously in a thread pool since ddgs has no native async API.
    """
    def _sync() -> list[dict]:
        # `ddgs` is the current package; `duckduckgo_search` is the deprecated alias
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS  # type: ignore[no-redef]
        results: list[dict] = []
        try:
            for r in (DDGS().text(query, max_results=None) or []):
                url = r.get("href", "")
                if not url:
                    continue
                results.append({
                    "title": r.get("title", ""),
                    "url": url,
                    "snippet": r.get("body", ""),
                    "source": urlparse(url).netloc.replace("www.", "") if url else "",
                    "published_at": None,
                    "engine": "duckduckgo",
                })
        except Exception as exc:
            logger.warning("[ddg] search failed: %s", exc)
        return results

    results = await asyncio.to_thread(_sync)
    logger.debug("[ddg] %d results for '%s'", len(results), query[:60])
    return results


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


# ── Bing HTML scraping (curl_cffi browser impersonation) ─────────────────────

def _unwrap_bing_ck_url(href: str) -> str:
    """Decode a Bing /ck/a?...&u=a1<base64url>... tracking redirect.

    Bing embeds the destination URL as base64url after the 'a1' prefix in the
    'u' query parameter.  Returns the real URL, or '' if it can't be decoded.
    """
    if "bing.com/ck/" not in href:
        return href
    try:
        import base64
        from urllib.parse import parse_qs
        qs = parse_qs(urlparse(href).query)
        u = qs.get("u", [""])[0]
        if u.startswith("a1"):
            b64 = u[2:].replace("-", "+").replace("_", "/")
            b64 += "=" * (-len(b64) % 4)
            decoded = base64.b64decode(b64).decode("utf-8", errors="ignore")
            if decoded.startswith("http"):
                return decoded
    except Exception:
        pass
    return ""   # undecodable → caller should skip


def _bing_parse_page(html: str) -> list[dict]:
    """Parse one Bing SERP page.  Handles /ck/a?... tracking redirects."""
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    for li in soup.select("li.b_algo, .b_algo"):
        h2 = li.find("h2")
        if not h2:
            continue
        a = h2.find("a", href=True)
        if not a:
            continue
        title = a.get_text(strip=True)
        raw_href = a.get("href", "")

        if not raw_href:
            continue
        if "bing.com/ck/" in raw_href:
            url = _unwrap_bing_ck_url(raw_href)
        elif raw_href.startswith("http"):
            url = raw_href
        else:
            url = ""

        if not url or not title or url in seen:
            continue

        snippet = ""
        for sel in [".b_snippet", ".b_caption p", "p.b_para1", "p"]:
            el = li.select_one(sel)
            if el:
                snippet = el.get_text(strip=True)[:300]
                break

        try:
            source = urlparse(url).netloc.replace("www.", "")
        except Exception:
            source = ""

        seen.add(url)
        results.append({
            "title": title, "url": url, "snippet": snippet,
            "source": source, "published_at": None, "engine": "bing",
        })

    return results


async def bing_html_search(query: str, num: int = 50) -> list[dict]:
    """Bing HTML scraping via curl_cffi browser impersonation.

    Pages are fetched sequentially (not concurrently) to avoid rate-limiting.
    Stops early when a page returns no results.
    Decodes /ck/a tracking redirects via the u=a1<base64url> parameter.
    """
    from curl_cffi.requests import AsyncSession

    max_pages = min(10, (num + 9) // 10)
    seen: set[str] = set()
    all_results: list[dict] = []

    try:
        async with AsyncSession(impersonate="chrome124") as session:
            for page_idx in range(max_pages):
                first = 1 + page_idx * 10
                try:
                    resp = await session.get(
                        "https://www.bing.com/search",
                        params={"q": query, "first": first, "count": 10, "setlang": "en"},
                    )
                    page_items = _bing_parse_page(resp.text)
                    if not page_items:
                        break  # no more results — stop early
                    for item in page_items:
                        if item["url"] not in seen:
                            seen.add(item["url"])
                            all_results.append(item)
                    if len(all_results) >= num:
                        break
                except Exception as exc:
                    logger.warning("[bing] page first=%d failed: %s", first, exc)
                    break
    except Exception as exc:
        logger.warning("[bing] session failed: %s", exc)

    logger.debug("[bing] %d results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Google HTML scraping (curl_cffi browser impersonation) ───────────────────

def _unwrap_google_url(href: str) -> str:
    """Unwrap Google redirect URLs (/url?q=... → actual URL)."""
    if href.startswith("/url?"):
        from urllib.parse import parse_qs
        qs = parse_qs(href[5:])          # strip leading "/url?"
        candidates = qs.get("q", [])
        if candidates and candidates[0].startswith("http"):
            return candidates[0]
    return href


def _google_parse_page(html: str) -> list[dict]:
    """Parse Google Search result HTML.  Tries several selector strategies."""
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    # Strategy 1: div.yuRUbf / div.kb0PBd / div.N54PNb — canonical link wrappers
    for container_sel in ("div.yuRUbf", "div.kb0PBd", "div.N54PNb", "div.hlcw0c"):
        for wrap in soup.select(container_sel):
            a = wrap.select_one("a[href]")
            if not a:
                continue
            href = _unwrap_google_url(a.get("href", ""))
            if not href.startswith("http") or href in seen:
                continue
            h3 = a.find("h3") or wrap.find("h3")
            if not h3:
                continue
            title = h3.get_text(strip=True)
            if not title:
                continue
            snippet = ""
            # Walk up to find snippet in same result block
            block = wrap.find_parent("div", class_=True)
            if block:
                for cls in ("VwiC3b", "IsZvec", "s3v9rd", "st", "yDYNvb"):
                    el = block.select_one(f".{cls}")
                    if el:
                        snippet = el.get_text(separator=" ", strip=True)[:300]
                        break
            try:
                source = urlparse(href).netloc.replace("www.", "")
            except Exception:
                source = ""
            seen.add(href)
            results.append({"title": title, "url": href, "snippet": snippet,
                             "source": source, "published_at": None, "engine": "google"})
        if results:
            break

    # Strategy 2: div.g containers
    if not results:
        for g in soup.select("div.g"):
            a = g.select_one("a[href]")
            if not a:
                continue
            href = _unwrap_google_url(a.get("href", ""))
            if not href.startswith("http") or "google.com" in href or href in seen:
                continue
            h3 = g.find("h3")
            if not h3:
                continue
            title = h3.get_text(strip=True)
            if not title:
                continue
            snippet = ""
            for cls in ("VwiC3b", "IsZvec", "st", "yDYNvb"):
                el = g.select_one(f".{cls}")
                if el:
                    snippet = el.get_text(separator=" ", strip=True)[:300]
                    break
            try:
                source = urlparse(href).netloc.replace("www.", "")
            except Exception:
                source = ""
            seen.add(href)
            results.append({"title": title, "url": href, "snippet": snippet,
                             "source": source, "published_at": None, "engine": "google"})

    # Strategy 3: universal h3-inside-<a> fallback
    if not results:
        for h3 in soup.find_all("h3"):
            a = h3.find_parent("a") or h3.find("a")
            if not a:
                continue
            href = _unwrap_google_url(a.get("href", ""))
            if not href.startswith("http") or "google.com" in href or href in seen:
                continue
            title = h3.get_text(strip=True)
            if not title:
                continue
            snippet = ""
            parent = h3.find_parent("div")
            if parent:
                for span in parent.find_all("span"):
                    text = span.get_text(strip=True)
                    if len(text) > 60 and text != title:
                        snippet = text[:300]
                        break
            try:
                source = urlparse(href).netloc.replace("www.", "")
            except Exception:
                source = ""
            seen.add(href)
            results.append({"title": title, "url": href, "snippet": snippet,
                             "source": source, "published_at": None, "engine": "google"})

    return results


def _ecosia_parse_page(html: str) -> list[dict]:
    """Parse one Ecosia SERP page.

    Ecosia's HTML: result titles are <h2> or <h3> elements nested inside <a>
    links that point directly to the external URL.  Use find_parent('a') to
    retrieve the link from the heading.
    """
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    for h in soup.find_all(["h2", "h3"]):
        a = h.find_parent("a") or h.find("a")
        if not a:
            continue
        href = a.get("href", "")
        if not href.startswith("http") or "ecosia.org" in href or href in seen:
            continue
        title = h.get_text(strip=True)
        if not title:
            continue
        # Snippet: nearest <p> in the surrounding result block
        snippet = ""
        parent = h.find_parent("article") or h.find_parent("div")
        if parent:
            p = parent.find("p")
            if p:
                snippet = p.get_text(strip=True)[:300]
        try:
            source = urlparse(href).netloc.replace("www.", "")
        except Exception:
            source = ""
        seen.add(href)
        results.append({"title": title, "url": href, "snippet": snippet,
                         "source": source, "published_at": None, "engine": "google"})

    return results


async def google_html_search(query: str, num: int = 30) -> list[dict]:
    """Search via Ecosia (uses Bing index) as a fallback for Google HTML scraping.

    Google's web search now returns a JavaScript-only shell that cannot be
    parsed with BeautifulSoup.  Ecosia delivers server-rendered HTML and
    returns the same results labelled as 'google' engine for UI consistency.
    """
    from curl_cffi.requests import AsyncSession

    max_pages = min(5, (num + 9) // 10)
    seen: set[str] = set()
    all_results: list[dict] = []

    try:
        async with AsyncSession(impersonate="chrome124") as session:
            for page_idx in range(max_pages):
                try:
                    resp = await session.get(
                        "https://www.ecosia.org/search",
                        params={"q": query, "p": page_idx, "addon": "opensearch"},
                    )
                    if "captcha" in resp.text.lower() or "blocked" in resp.url.lower():
                        logger.warning("[ecosia] blocked for '%s'", query[:60])
                        break
                    page_items = _ecosia_parse_page(resp.text)
                    if not page_items:
                        logger.debug("[ecosia] page %d: 0 items", page_idx)
                        break
                    for item in page_items:
                        if item["url"] not in seen:
                            seen.add(item["url"])
                            all_results.append(item)
                    if len(all_results) >= num:
                        break
                except Exception as exc:
                    logger.warning("[ecosia] page %d failed: %s", page_idx, exc)
                    break
    except Exception as exc:
        logger.warning("[ecosia] session failed: %s", exc)

    logger.debug("[ecosia→google] %d results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Yahoo Search (Bing index, clean extractable URLs) ────────────────────────

def _yahoo_real_url(href: str) -> str:
    """Extract destination URL from Yahoo's /RU=ENCODED_URL/RK= redirect."""
    if "/RU=" in href:
        try:
            from urllib.parse import unquote
            ru_idx = href.index("/RU=") + 4
            rk_idx = href.find("/RK=", ru_idx)
            end = rk_idx if rk_idx != -1 else len(href)
            return unquote(href[ru_idx:end])
        except (ValueError, IndexError):
            pass
    if href.startswith("http") and "yahoo.com" not in href:
        return href
    return ""


async def yahoo_search(query: str, num: int = 50) -> list[dict]:
    """Yahoo Search — uses Bing's index but returns clean (non-tracking) URLs.

    Uses uk.search.yahoo.com to bypass regional GDPR consent gate.
    Pages are fetched sequentially (not concurrently) to avoid rate-limiting.
    Yahoo's HTML has <a> wrapping <h3> — use h3.find_parent('a') to get the link.
    """
    from curl_cffi.requests import AsyncSession

    max_pages = min(10, (num + 9) // 10)
    seen: set[str] = set()
    all_results: list[dict] = []

    try:
        async with AsyncSession(impersonate="chrome124") as session:
            for page_idx in range(max_pages):
                b = 1 + page_idx * 10
                try:
                    resp = await session.get(
                        "https://uk.search.yahoo.com/search",
                        params={"p": query, "b": b, "ei": "UTF-8"},
                    )
                    soup = BeautifulSoup(resp.text, "lxml")
                    page_items: list[dict] = []
                    for result in soup.select("div.algo"):
                        h3 = result.find("h3")
                        if not h3:
                            continue
                        # Yahoo wraps <h3> inside <a> — parent-of-h3 gives us the link
                        a = h3.find_parent("a")
                        if not a:
                            a = h3.find("a", href=True)  # fallback
                        if not a:
                            continue
                        href = a.get("href", "")
                        url = _yahoo_real_url(href)
                        if not url or url in seen:
                            continue
                        title = h3.get_text(strip=True)
                        if not title:
                            continue
                        snippet = ""
                        comp = result.select_one(".compText p")
                        if comp:
                            snippet = comp.get_text(strip=True)[:300]
                        if not snippet:
                            for sel in [".compText span", "p.fc-falcon", "p.fst", "p"]:
                                el = result.select_one(sel)
                                if el:
                                    snippet = el.get_text(strip=True)[:300]
                                    break
                        try:
                            source = urlparse(url).netloc.replace("www.", "")
                        except Exception:
                            source = ""
                        seen.add(url)
                        page_items.append({"title": title, "url": url, "snippet": snippet,
                                           "source": source, "published_at": None, "engine": "yahoo"})
                    if not page_items:
                        break  # no more results — stop early
                    all_results.extend(page_items)
                    if len(all_results) >= num:
                        break
                except Exception as exc:
                    logger.warning("[yahoo] page b=%d failed: %s", b, exc)
                    break
    except Exception as exc:
        logger.warning("[yahoo] search failed: %s", exc)

    logger.debug("[yahoo] %d results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Startpage Search (Google results, privacy-first proxy) ───────────────────

def _startpage_parse(html: str) -> list[dict]:
    """Parse one Startpage /do/search page.

    Startpage's HTML (CSS-in-JS / Emotion): each result is a `div.result` container.
    Each result has 4+ <a> pointing to the same external URL:
      1. favicon link (empty text)
      2. domain text (e.g. "Python.org")
      3. URL-as-text (starts with "http")
      4. page title (e.g. "Welcome to Python.org")  ← what we want
      + startpage proxy link ("Visit in Anonymous View")

    Title heuristic: first external link whose text is non-empty, does not
    start with "http", is not a bare domain ("x.com"), and is longer than 15 chars.
    Snippet: first <p> inside the container.
    """
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    for container in soup.select("div.result"):
        # All external links in this container (excluding startpage proxy)
        ext_links = [
            a for a in container.find_all("a", href=True)
            if a.get("href", "").startswith("http")
            and "startpage.com" not in a.get("href", "")
        ]
        if not ext_links:
            continue

        # URL is the same for all — take from first link
        href = ext_links[0].get("href", "")
        if not href or href in seen:
            continue

        # Find title: first link with meaningful text (not URL-looking, len > 10)
        title = ""
        for a in ext_links:
            text = a.get_text(separator=" ", strip=True)
            if text and not text.startswith("http") and len(text) > 10:
                title = text
                break
        if not title:
            continue

        # Snippet: first <p>
        snippet = ""
        p = container.find("p")
        if p:
            snippet = p.get_text(strip=True)[:300]

        try:
            source = urlparse(href).netloc.replace("www.", "")
        except Exception:
            source = ""

        seen.add(href)
        results.append({"title": title, "url": href, "snippet": snippet,
                         "source": source, "published_at": None, "engine": "startpage"})

    return results


async def startpage_search(query: str, num: int = 30) -> list[dict]:
    """Startpage.com — Google results proxied through a privacy-focused engine.

    Uses /do/search endpoint (the /sp/search endpoint gets CAPTCHA-blocked).
    Pages are fetched sequentially; stops early when a page returns no results.
    """
    from curl_cffi.requests import AsyncSession

    max_pages = min(5, (num + 9) // 10)
    seen: set[str] = set()
    all_results: list[dict] = []

    try:
        async with AsyncSession(impersonate="chrome124") as session:
            for page_idx in range(max_pages):
                try:
                    resp = await session.get(
                        "https://www.startpage.com/do/search",
                        params={"q": query, "cat": "web", "pg": page_idx + 1},
                    )
                    page_items = _startpage_parse(resp.text)
                    if not page_items:
                        break  # no more results — stop early
                    for item in page_items:
                        if item["url"] not in seen:
                            seen.add(item["url"])
                            all_results.append(item)
                    if len(all_results) >= num:
                        break
                except Exception as exc:
                    logger.warning("[startpage] page %d failed: %s", page_idx + 1, exc)
                    break
    except Exception as exc:
        logger.warning("[startpage] search failed: %s", exc)

    logger.debug("[startpage] %d results for '%s'", len(all_results), query[:60])
    return all_results[:num]


# ── Full parallel search (all engines combined) ───────────────────────────────

async def full_web_search(query: str, num: int = 100) -> dict:
    """Run DDG, Bing, Google, Yahoo, and Startpage in parallel.

    All 5 engines run simultaneously; results are merged and deduplicated by
    normalised URL.  Each engine gets its own num-sized budget so that slow or
    partially-blocked engines don't reduce the total.
    """
    ddg_task   = duckduckgo_search(query, num=num)
    bing_task  = bing_html_search(query, num=num)
    goog_task  = google_html_search(query, num=num)
    yahoo_task = yahoo_search(query, num=num)
    sp_task    = startpage_search(query, num=num)

    ddg_r, bing_r, goog_r, yahoo_r, sp_r = await asyncio.gather(
        ddg_task, bing_task, goog_task, yahoo_task, sp_task,
        return_exceptions=True,
    )

    def _safe(r: object) -> list[dict]:
        if isinstance(r, Exception):
            logger.warning("[full_search] engine error: %s", r)
            return []
        return r or []

    ddg_r   = _safe(ddg_r)
    bing_r  = _safe(bing_r)
    goog_r  = _safe(goog_r)
    yahoo_r = _safe(yahoo_r)
    sp_r    = _safe(sp_r)

    logger.info(
        "[full_search] raw — DDG:%d Bing:%d Google:%d Yahoo:%d Startpage:%d for '%s'",
        len(ddg_r), len(bing_r), len(goog_r), len(yahoo_r), len(sp_r), query[:60],
    )

    # Merge in priority order: DDG → Yahoo → Bing → Startpage → Google
    # (Yahoo first among Bing-family since it has clean non-tracking URLs)
    seen: set[str] = set()
    merged: list[dict] = []
    for item in ddg_r + yahoo_r + bing_r + sp_r + goog_r:
        url = item.get("url", "")
        norm = url.strip().lower().rstrip("/").split("?")[0]
        if norm and norm not in seen:
            seen.add(norm)
            merged.append(item)

    # Sort by published_at descending; results without a date go last.
    def _pub_key(item: dict):
        pub = item.get("published_at")
        if not pub:
            return ""
        return pub if isinstance(pub, str) else str(pub)

    merged.sort(key=_pub_key, reverse=True)

    # Sort per-engine lists the same way
    for lst in (ddg_r, bing_r, goog_r, yahoo_r, sp_r):
        lst.sort(key=_pub_key, reverse=True)

    return {
        "results": merged,        # no count cap — return everything
        "total": len(merged),
        "engines": {
            "duckduckgo": len(ddg_r),
            "bing": len(bing_r),
            "google": len(goog_r),
            "yahoo": len(yahoo_r),
            "startpage": len(sp_r),
        },
        # Raw per-engine results (before cross-engine deduplication).
        # The frontend uses these for engine-specific filter tabs so that
        # results aren't missing just because the same URL was found first
        # by a higher-priority engine in the merged list.
        "per_engine": {
            "duckduckgo": ddg_r,
            "bing": bing_r,
            "google": goog_r,
            "yahoo": yahoo_r,
            "startpage": sp_r,
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
