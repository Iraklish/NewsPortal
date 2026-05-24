"""Three-layer dedup: URL hash → title hash → fuzzy title match."""
import hashlib

from sqlalchemy.orm import Session

from ..models import Article


def url_hash(url: str) -> str:
    normalized = url.strip().lower().split("?")[0].rstrip("/")
    return hashlib.sha256(normalized.encode()).hexdigest()


def title_hash(title: str) -> str:
    return hashlib.sha256(title.lower().strip().encode()).hexdigest()


def is_duplicate(url: str, title: str | None, db: Session) -> bool:
    """Return True if an article with this URL or title (exact/fuzzy) already exists."""
    if db.query(Article).filter(Article.url_hash == url_hash(url)).first():
        return True
    if title:
        if db.query(Article).filter(Article.title_hash == title_hash(title)).first():
            return True
        if _fuzzy_title_match(title, db):
            return True
    return False


def _fuzzy_title_match(title: str, db: Session) -> bool:
    """Jaccard >= 0.80 against the last 500 article titles."""
    words = {w.lower() for w in title.split() if len(w) > 3}
    if len(words) < 3:
        return False

    recent = db.query(Article.title).order_by(Article.id.desc()).limit(500).all()
    for (existing_title,) in recent:
        if not existing_title:
            continue
        existing_words = {w.lower() for w in existing_title.split() if len(w) > 3}
        if not existing_words:
            continue
        intersection = words & existing_words
        union = words | existing_words
        if union and len(intersection) / len(union) >= 0.80:
            return True
    return False
