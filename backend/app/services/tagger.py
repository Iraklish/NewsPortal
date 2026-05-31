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
    """Call AI to extract at least 10 English topic tags regardless of article language.

    Returns an empty list when the model genuinely produces no parseable tags.
    Raises on a hard failure (e.g. AI provider/API error) so callers can tell a
    real error apart from an empty result and surface a meaningful message.
    """
    from .ai_client import call_ai

    title = article.title or "(no title)"
    excerpt = (article.content or article.summary or "")[:1000]

    system = (
        "You are a multilingual topic-tagging assistant. Extract canonical English topic tags "
        "from news articles. The article may be in ANY language — always return tags in English. "
        "Tags must be concise noun phrases (2-5 words). Provide AT LEAST 10 tags, covering the "
        "main topics plus related entities, sectors, regions, people, and themes mentioned. "
        "Return ONLY a valid JSON array of strings, nothing else. "
        "Example: [\"ceasefire negotiations\", \"Middle East diplomacy\", \"US foreign policy\"]"
    )
    user = (
        f"Title: {title}\n\n"
        f"Text excerpt:\n{excerpt}\n\n"
        "Return at least 10 English topic tags as a JSON array:"
    )

    # Let provider/API errors propagate — they are real failures the caller must
    # report, not "no tags". Logged at WARNING so they land in app.log.
    try:
        raw = await call_ai(system=system, user=user, max_tokens=500, db=db)
    except Exception as exc:
        logger.warning("[tagger] AI call failed for article %s: %s", article.id, exc)
        raise

    # Parsing problems are soft: the call succeeded but the output wasn't usable.
    try:
        cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        s, e = cleaned.find("["), cleaned.rfind("]")
        if s == -1 or e == -1:
            logger.warning("[tagger] no JSON array in response for article %s: %.120s", article.id, raw)
            return []
        tags = json.loads(cleaned[s: e + 1])
    except Exception as exc:
        logger.warning("[tagger] could not parse tags for article %s: %s", article.id, exc)
        return []

    # Deduplicate (case-insensitive) while preserving order; cap at 20.
    seen: set[str] = set()
    result: list[str] = []
    for t in tags:
        t = str(t).strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            result.append(t)
    return result[:20]
