"""AI-powered topic tag extraction for news articles.

Shared between the articles router (manual/bulk tagging) and the background
scheduler (automatic tagging on fetch when enabled per category).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from ..models import Article

logger = logging.getLogger(__name__)

# Substrings that identify a transient rate-limit / quota error from the AI
# provider (Gemini returns 429 RESOURCE_EXHAUSTED; OpenAI returns 429 rate limit).
_RATE_LIMIT_MARKERS = (
    "rate limit", "ratelimit", "resource_exhausted", "resource exhausted",
    "quota", "429", "too many requests", "overloaded", "unavailable", "503",
)

# Default backoff (seconds) when the provider does not tell us how long to wait.
_DEFAULT_BACKOFF = (5, 15, 30, 60, 90)
_MAX_RETRY_DELAY = 120  # never sleep longer than this between attempts


def _is_rate_limit_error(msg: str) -> bool:
    low = msg.lower()
    return any(m in low for m in _RATE_LIMIT_MARKERS)


def _parse_retry_delay(msg: str) -> float | None:
    """Extract a server-suggested retry delay (seconds) from an error message.

    Handles the shapes Gemini/OpenAI emit, e.g.:
      - "...'retryDelay': '37s'..."           (Gemini RetryInfo)
      - "Please retry after 37 seconds"        (OpenAI)
      - "retry in 37s" / "try again in 37.5s"
    Returns None when no explicit delay is present.
    """
    patterns = (
        r"retry[_-]?delay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)\s*s",
        r"retry(?:\s+after|\s+in)?\s+(\d+(?:\.\d+)?)\s*(?:s\b|seconds?)",
        r"try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:s\b|seconds?)",
        r"(\d+(?:\.\d+)?)\s*seconds?",
    )
    for pat in patterns:
        m = re.search(pat, msg, re.IGNORECASE)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                continue
    return None


async def ai_extract_tags(article: Article, db, max_retries: int = 5) -> list[str]:
    """Call AI to extract at least 10 English topic tags regardless of article language.

    Returns an empty list when the model genuinely produces no parseable tags.
    Raises on a hard failure (e.g. AI provider/API error) so callers can tell a
    real error apart from an empty result and surface a meaningful message.
    """
    from .ai_client import call_ai, get_ai_settings_for_task

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

    # Call the AI, retrying on transient rate-limit/quota errors while honoring
    # any server-suggested retry delay ("retry in Xs"). Non-rate-limit errors
    # propagate immediately so callers can tell a real failure from "no tags".
    ai_provider, ai_model = await get_ai_settings_for_task("tagging", db)
    raw = None
    attempt = 0
    while True:
        try:
            raw = await call_ai(system=system, user=user, max_tokens=500, provider=ai_provider, model=ai_model, db=db)
            break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            msg = str(exc)
            if _is_rate_limit_error(msg) and attempt < max_retries:
                # Prefer the server's own retry hint; fall back to backoff schedule.
                delay = _parse_retry_delay(msg)
                if delay is None:
                    delay = _DEFAULT_BACKOFF[min(attempt, len(_DEFAULT_BACKOFF) - 1)]
                delay = min(delay + 1.0, _MAX_RETRY_DELAY)  # +1s safety margin
                attempt += 1
                logger.warning(
                    "[tagger] rate-limited on article %s — waiting %.0fs then retrying "
                    "(attempt %d/%d)", article.id, delay, attempt, max_retries,
                )
                await asyncio.sleep(delay)
                continue
            logger.warning("[tagger] AI call failed for article %s: %s", article.id, exc)
            raise

    # The model can legitimately return an empty/None response (e.g. blocked or
    # no candidate text) — that's "no tags", not a parse error.
    if not raw or not str(raw).strip():
        logger.info("[tagger] empty AI response for article %s — no tags", article.id)
        return []

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
