"""AI-powered topic tag extraction for news articles.

Shared between the articles router (manual/bulk tagging) and the background
scheduler (automatic tagging on fetch when enabled per category).
"""
from __future__ import annotations

import json
import logging
import re

from ..models import Article

logger = logging.getLogger(__name__)


async def ai_extract_tags(article: Article, db) -> list[str]:
    """Call AI to extract 3-7 English topic tags regardless of article language.

    Returns an empty list on any error so callers can safely ignore failures.
    """
    from .ai_client import call_ai

    title = article.title or "(no title)"
    excerpt = (article.content or article.summary or "")[:1000]

    system = (
        "You are a multilingual topic-tagging assistant. Extract canonical English topic tags "
        "from news articles. The article may be in ANY language — always return tags in English. "
        "Tags must be concise noun phrases (2-5 words). Return ONLY a valid JSON array of strings, "
        "nothing else. Example: [\"ceasefire negotiations\", \"Middle East diplomacy\", \"US foreign policy\"]"
    )
    user = (
        f"Title: {title}\n\n"
        f"Text excerpt:\n{excerpt}\n\n"
        "Return 3-7 English topic tags as a JSON array:"
    )

    try:
        raw = await call_ai(system=system, user=user, max_tokens=250, db=db)
        cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        s, e = cleaned.find("["), cleaned.rfind("]")
        if s == -1 or e == -1:
            logger.debug("[tagger] could not find JSON array in response: %.80s", raw)
            return []
        tags = json.loads(cleaned[s: e + 1])
        return [str(t).strip() for t in tags if str(t).strip()][:10]
    except Exception as exc:
        logger.debug("[tagger] tag extraction failed for article %d: %s", article.id, exc)
        return []
