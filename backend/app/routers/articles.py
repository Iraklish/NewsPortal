import hashlib
import io
import logging
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

import feedparser
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Article
from ..schemas import ArticleOut
from ..services.scheduler import run_fetch_now
from ..services.search_service import fetch_url

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Deduplication helpers ─────────────────────────────────────────────────────

def _url_hash(url: str) -> str:
    normalized = url.strip().lower().split("?")[0].rstrip("/")
    return hashlib.sha256(normalized.encode()).hexdigest()


def _title_hash(title: str) -> str:
    return hashlib.sha256(title.lower().strip().encode()).hexdigest()


def _fuzzy_title_match(title: str, db: Session) -> bool:
    """Return True if an existing article shares >80% of words with this title."""
    words = set(w.lower() for w in title.split() if len(w) > 3)
    if len(words) < 3:
        return False

    # Load last 500 articles for comparison (performance guard)
    recent = db.query(Article.title).order_by(Article.id.desc()).limit(500).all()
    for (existing_title,) in recent:
        if not existing_title:
            continue
        existing_words = set(w.lower() for w in existing_title.split() if len(w) > 3)
        if not existing_words:
            continue
        intersection = words & existing_words
        union = words | existing_words
        if len(union) > 0 and len(intersection) / len(union) >= 0.80:
            return True
    return False


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
    links = getattr(entry, "links", [])
    for link in links:
        if isinstance(link, dict) and link.get("type", "").startswith("image"):
            return link.get("href")
    return None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/categories")
def list_categories(db: Session = Depends(get_db)):
    """Return distinct non-null categories."""
    rows = db.query(Article.category).filter(Article.category.isnot(None)).distinct().all()
    return [r[0] for r in rows if r[0]]


@router.get("/count")
def count_articles(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Total article count for the given filters (independent of paging)."""
    query = db.query(Article.id)
    if category:
        query = query.filter(Article.category == category)
    if q:
        query = query.filter(
            or_(
                Article.title.ilike(f"%{q}%"),
                Article.content.ilike(f"%{q}%"),
                Article.summary.ilike(f"%{q}%"),
            )
        )
    return {"count": query.count()}


@router.get("", response_model=list[ArticleOut])
def list_articles(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(Article)
    if category:
        query = query.filter(Article.category == category)
    if q:
        query = query.filter(
            or_(
                Article.title.ilike(f"%{q}%"),
                Article.content.ilike(f"%{q}%"),
                Article.summary.ilike(f"%{q}%"),
            )
        )
    # Effective date = min(published_at, fetched_at). Caps feeds that report future
    # publish dates (which would otherwise pin stale items to the top) and falls back
    # to fetched_at when published_at is missing.
    effective_date = func.min(
        func.coalesce(Article.published_at, Article.fetched_at),
        Article.fetched_at,
    )
    return (
        query.order_by(effective_date.desc(), Article.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.get("/trending-topics")
def trending_topics(
    limit: int = Query(20, ge=5, le=50),
    hours: int = Query(72, ge=1, le=336),
    db: Session = Depends(get_db),
):
    """Mine noun-phrase frequency from recent article titles to surface trending topics.

    Returns up to `limit` topics sorted by occurrence count, deduplicating
    sub-phrases that are already covered by a longer phrase.
    """
    import re
    from collections import Counter
    from datetime import timedelta

    cutoff = datetime.utcnow() - timedelta(hours=hours)

    rows = (
        db.query(Article.title, Article.category)
        .filter(
            or_(
                Article.published_at >= cutoff,
                Article.fetched_at >= cutoff,
            )
        )
        .order_by(Article.fetched_at.desc())
        .limit(600)
        .all()
    )
    # Fall back to most-recent 300 if the time window is nearly empty
    if len(rows) < 20:
        rows = (
            db.query(Article.title, Article.category)
            .order_by(Article.fetched_at.desc())
            .limit(300)
            .all()
        )

    # Words that are capitalised in headlines but carry no topical meaning
    _SKIP = {
        "The", "A", "An", "In", "On", "At", "To", "Of", "For", "And", "Or",
        "But", "With", "By", "As", "Is", "Are", "Was", "Were", "Be", "Has",
        "Have", "Had", "Not", "No", "New", "More", "One", "Two", "Three",
        "Its", "His", "Her", "Their", "Our", "This", "That", "What", "Who",
        "How", "Why", "When", "After", "Before", "While", "Since", "Into",
        "Over", "From", "About", "Up", "Says", "Said", "Will", "Can", "May",
        "Should", "Could", "Would", "Also", "Just", "Still", "Even", "First",
        "Last", "Next", "Top", "High", "Low", "Big", "Key", "Live", "Latest",
        "Day", "Week", "Year", "Month", "Time", "Way", "World", "Report",
        "Update", "Watch", "Read", "Here", "Now", "Today", "amid", "amid",
    }

    phrase_counter: Counter = Counter()
    titles = [r[0] for r in rows if r[0]]

    for title in titles:
        # Tokens: sequences of title-case words, allowing hyphens (e.g. "Russia-Ukraine")
        tokens = re.findall(r'\b([A-Z][a-zA-Z\'\-]+)\b', title)
        filtered = [t for t in tokens if t not in _SKIP and len(t) > 2]

        # Collect 2- and 3-word phrases (prefer longer; single words added separately)
        for n in (3, 2):
            for i in range(len(filtered) - n + 1):
                phrase_counter[" ".join(filtered[i : i + n])] += 1
        # High-frequency single proper nouns (countries, people, orgs)
        for tok in filtered:
            phrase_counter[tok] += 1

    # Build de-duplicated list: skip a phrase if it is a strict substring of
    # a longer phrase we already included
    top = [(p, c) for p, c in phrase_counter.most_common(200) if c >= 2]
    selected: list[str] = []
    selected_lower: set[str] = set()

    for phrase, _ in top:
        pl = phrase.lower()
        if any(pl in s for s in selected_lower):
            continue  # covered by a longer phrase
        selected.append(phrase)
        selected_lower.add(pl)
        if len(selected) >= limit:
            break

    # Pad with category names when the window is sparse
    if len(selected) < limit:
        cats = sorted({r[1] for r in rows if r[1]})
        for cat in cats:
            if cat.lower() not in selected_lower:
                selected.append(cat.title())
                selected_lower.add(cat.lower())
            if len(selected) >= limit:
                break

    return {"topics": selected}


@router.get("/{article_id}", response_model=ArticleOut)
def get_article(article_id: int, db: Session = Depends(get_db)):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return article


@router.delete("/{article_id}")
def delete_article(article_id: int, db: Session = Depends(get_db)):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    db.delete(article)
    db.commit()
    return {"deleted": True, "id": article_id}


# ── POST /articles  (primary create endpoint) ────────────────────────────────

class ArticleIn(BaseModel):
    title: Optional[str] = None
    content: str
    url: Optional[str] = None          # canonical URL for dedup; synthesised if omitted
    category: str = "post"             # defaults to "post"; any string is accepted
    source: Optional[str] = None
    author: Optional[str] = None
    summary: Optional[str] = None
    published_at: Optional[datetime] = None
    is_html: bool = False              # set True to strip HTML tags from content


@router.post("", response_model=ArticleOut, status_code=201)
def create_article(body: ArticleIn, db: Session = Depends(get_db)):
    """Create an article manually.

    Sends the payload through the standard 3-layer dedup check (URL hash →
    title hash → fuzzy title match) and stores the result.  The default
    category is ``post``; supply any other string to override.
    """
    content = _strip_html(body.content) if body.is_html else body.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="content must not be empty")
    return _insert_article(
        db,
        title=body.title,
        content=content,
        summary=body.summary,
        source=body.source,
        category=body.category or "post",
        url=body.url,
        author=body.author,
        published_at=body.published_at,
    )


# ── Manual add ───────────────────────────────────────────────────────────────

class ManualArticleIn(BaseModel):
    title: Optional[str] = None
    content: str
    summary: Optional[str] = None
    source: Optional[str] = None
    category: str = "manual"
    url: Optional[str] = None
    author: Optional[str] = None
    published_at: Optional[datetime] = None
    is_html: bool = False  # if True, strip tags from content


def _strip_html(html: str) -> str:
    from bs4 import BeautifulSoup
    return BeautifulSoup(html, "lxml").get_text(separator="\n", strip=True)


def _insert_article(
    db: Session,
    *,
    title: Optional[str],
    content: str,
    summary: Optional[str] = None,
    source: Optional[str] = None,
    category: str = "manual",
    url: Optional[str] = None,
    author: Optional[str] = None,
    published_at: Optional[datetime] = None,
    image_url: Optional[str] = None,
) -> Article:
    """Create an article with 3-layer dedup. Raises HTTPException(409) on duplicate."""
    if not content or not content.strip():
        raise HTTPException(status_code=422, detail="content is required")

    title = (title or "").strip() or None
    synthetic_url = url or f"manual://{datetime.utcnow().timestamp()}/{hashlib.sha256((title or content[:200]).encode()).hexdigest()[:16]}"
    hash_val = _url_hash(synthetic_url)
    if db.query(Article).filter(Article.url_hash == hash_val).first():
        raise HTTPException(status_code=409, detail="An article with this URL already exists")

    if title:
        t_hash = _title_hash(title)
        if db.query(Article).filter(Article.title_hash == t_hash).first():
            raise HTTPException(status_code=409, detail="An article with this title already exists")
        if _fuzzy_title_match(title, db):
            raise HTTPException(status_code=409, detail="A very similar article already exists")

    article = Article(
        url=synthetic_url,
        url_hash=hash_val,
        title=title,
        title_hash=_title_hash(title) if title else None,
        source=source or "manual",
        category=(category or "manual").strip().lower() or "manual",
        published_at=published_at,
        content=content,  # store full document — TEXT column has no practical limit
        summary=(summary or content)[:1000] if (summary or content) else None,
        author=author,
        image_url=image_url,
        is_analyzed=False,
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    return article


@router.post("/manual", response_model=ArticleOut, status_code=201)
def add_manual_article(body: ManualArticleIn, db: Session = Depends(get_db)):
    """Add an article from raw text or HTML/markdown."""
    content = body.content
    if body.is_html:
        content = _strip_html(content)
    return _insert_article(
        db,
        title=body.title,
        content=content,
        summary=body.summary,
        source=body.source,
        category=body.category,
        url=body.url,
        author=body.author,
        published_at=body.published_at,
    )


class FetchUrlIn(BaseModel):
    url: str
    category: str = "manual"


@router.post("/from-url", response_model=ArticleOut, status_code=201)
async def add_from_url(body: FetchUrlIn, db: Session = Depends(get_db)):
    """Fetch an article from a URL (parses meta tags + extracts main text)."""
    if not body.url.strip():
        raise HTTPException(status_code=422, detail="url is required")
    try:
        fetched = await fetch_url(body.url.strip())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")
    if fetched.get("status") != "ok" or not (fetched.get("content") or "").strip():
        raise HTTPException(status_code=400, detail=fetched.get("error") or "URL returned no usable content")

    # published_at from <meta> is a string; try to parse, fall back to None
    pub_raw = fetched.get("published_at")
    pub_dt: Optional[datetime] = None
    if isinstance(pub_raw, datetime):
        pub_dt = pub_raw
    elif isinstance(pub_raw, str) and pub_raw.strip():
        try:
            pub_dt = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
            if pub_dt.tzinfo is not None:
                pub_dt = pub_dt.replace(tzinfo=None)
        except ValueError:
            pub_dt = None

    return _insert_article(
        db,
        title=fetched.get("title"),
        content=fetched["content"],
        summary=fetched.get("description") or fetched.get("summary"),
        source=fetched.get("source") or urlparse(body.url).netloc.replace("www.", ""),
        category=body.category,
        url=body.url.strip(),
        author=fetched.get("author"),
        published_at=pub_dt,
        image_url=fetched.get("image_url"),
    )


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    return "\n\n".join((page.extract_text() or "") for page in reader.pages).strip()


def _extract_docx(data: bytes) -> str:
    from docx import Document
    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs if p.text).strip()


@router.post("/from-document", response_model=ArticleOut, status_code=201)
async def add_from_document(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    category: str = Form("manual"),
    source: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload a document (.pdf, .docx, .txt, .md, .html) and store it as an article."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")

    name = (file.filename or "document").lower()
    text = ""
    try:
        if name.endswith(".pdf"):
            text = _extract_pdf(raw)
        elif name.endswith(".docx"):
            text = _extract_docx(raw)
        elif name.endswith((".html", ".htm")):
            text = _strip_html(raw.decode("utf-8", errors="ignore"))
        else:
            # Treat anything else as plain text (.txt, .md, .csv, …)
            text = raw.decode("utf-8", errors="ignore")
    except Exception as exc:
        logger.error("Failed to extract %s: %s", name, exc)
        raise HTTPException(status_code=400, detail=f"Failed to extract document text: {exc}")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="No text could be extracted from the document")

    inferred_title = title or file.filename or text.split("\n", 1)[0][:200]
    return _insert_article(
        db,
        title=inferred_title,
        content=text,
        source=source or file.filename or "uploaded document",
        category=category,
    )


# ── Background fetch trigger ─────────────────────────────────────────────────

@router.post("/fetch-all")
async def fetch_all():
    """Manually trigger the same fetch the scheduler runs hourly."""
    new_ids = await run_fetch_now()
    return {"fetched": len(new_ids), "new_article_ids": new_ids}


@router.post("/fetch-feed")
def fetch_feed(body: dict, db: Session = Depends(get_db)):
    """Fetch an RSS/Atom feed URL and store new articles."""
    url = body.get("url", "").strip()
    category = body.get("category", "general")
    if not url:
        raise HTTPException(status_code=422, detail="url is required")

    try:
        feed = feedparser.parse(url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse feed: {exc}")

    if feed.bozo and not feed.entries:
        raise HTTPException(status_code=400, detail="Feed could not be parsed or is empty")

    feed_title = feed.feed.get("title", "") if hasattr(feed, "feed") else ""
    domain = urlparse(url).netloc.replace("www.", "")
    source = feed_title or domain

    imported = 0
    duplicates = 0
    errors = 0

    for entry in feed.entries:
        entry_url = entry.get("link", "").strip()
        if not entry_url:
            continue

        # Layer 1: URL hash dedup
        hash_val = _url_hash(entry_url)
        if db.query(Article).filter(Article.url_hash == hash_val).first():
            duplicates += 1
            continue

        title = entry.get("title", "").strip()

        # Layer 2: title hash dedup
        if title:
            t_hash = _title_hash(title)
            if db.query(Article).filter(Article.title_hash == t_hash).first():
                duplicates += 1
                continue

            # Layer 3: fuzzy match
            if _fuzzy_title_match(title, db):
                duplicates += 1
                continue

        # Extract content
        content = ""
        if entry.get("content"):
            for c in entry.content:
                content += c.get("value", "")
        if not content:
            content = entry.get("summary", "")

        # Strip HTML from content
        if content:
            from bs4 import BeautifulSoup
            content = BeautifulSoup(content, "lxml").get_text(separator=" ", strip=True)

        published_at = _parse_feed_date(entry)

        try:
            article = Article(
                url=entry_url,
                url_hash=hash_val,
                title=title or None,
                title_hash=_title_hash(title) if title else None,
                source=source,
                category=category,
                published_at=published_at,
                content=content[:15000] if content else None,
                summary=entry.get("summary", "")[:1000] if entry.get("summary") else None,
                author=entry.get("author", ""),
                image_url=_get_image(entry),
                is_analyzed=False,
            )
            db.add(article)
            db.commit()
            imported += 1
        except Exception as exc:
            db.rollback()
            logger.error("Failed to store feed entry %s: %s", entry_url, exc)
            errors += 1

    return {
        "imported": imported,
        "duplicates": duplicates,
        "errors": errors,
        "feed_title": feed_title,
        "total_entries": len(feed.entries),
    }
