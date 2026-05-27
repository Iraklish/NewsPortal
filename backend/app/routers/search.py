"""Web search endpoint — runs DuckDuckGo, Bing HTML and Google HTML in parallel."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("")
async def web_search(
    q: str = Query(..., min_length=1, description="Search query"),
    num: int = Query(50, ge=1, le=100, description="Max total results (across all engines)"),
):
    """Run DuckDuckGo Lite, Bing HTML, and Google HTML in parallel.

    Returns merged, deduplicated results tagged with their source engine.
    Each result has: title, url, snippet, source, published_at, engine.
    """
    from ..services.search_service import full_web_search
    try:
        data = await full_web_search(q.strip(), num=num)
        return data
    except Exception as exc:
        logger.exception("[search] full_web_search failed: %s", exc)
        return {"results": [], "total": 0, "engines": {"duckduckgo": 0, "bing": 0, "google": 0}, "error": str(exc)}
