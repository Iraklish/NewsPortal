"""Web search endpoint — runs DuckDuckGo, Bing HTML and Google HTML in parallel."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("")
async def web_search(
    q: str = Query(..., min_length=1, description="Search query"),
    num: int = Query(200, ge=1, le=500, description="Fetch depth per engine (controls how many pages each engine scrapes)"),
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


# ── Summarize selected results ────────────────────────────────────────────────

class WebResultIn(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    snippet: Optional[str] = None
    source: Optional[str] = None
    published_at: Optional[str] = None


class WebSummarizeRequest(BaseModel):
    query: Optional[str] = None
    results: List[WebResultIn]
    language: str = ""


_LANG_INSTRUCTIONS = {
    "Hebrew": "Respond entirely in Hebrew (עברית).",
    "Russian": "Respond entirely in Russian (Русский).",
    "Georgian": "Respond entirely in Georgian (ქართული).",
    "French": "Respond entirely in French (Français).",
    "German": "Respond entirely in German (Deutsch).",
    "Arabic": "Respond entirely in Arabic (العربية).",
    "Spanish": "Respond entirely in Spanish (Español).",
}

_MAX_SUMMARIZE = 100


@router.post("/summarize")
async def summarize_results(body: WebSummarizeRequest, db: Session = Depends(get_db)):
    """Summarize a user-selected set of web search results into a markdown briefing."""
    results = [r for r in body.results if (r.title or r.snippet or r.url)]
    if not results:
        raise HTTPException(status_code=400, detail="No results provided to summarize")
    used = results[:_MAX_SUMMARIZE]

    from ..services.ai_client import call_ai

    lines: list[str] = []
    for i, r in enumerate(used, 1):
        lines.append(
            f"[{i}] {r.title or '(no title)'}\n"
            f"    Source: {r.source or 'web'} | Published: {r.published_at or 'unknown'}\n"
            f"    URL: {r.url or ''}\n"
            f"    {(r.snippet or '').strip()}"
        )
    context = "\n\n".join(lines)

    lang = (body.language or "").strip()
    if lang and lang not in ("English", "english"):
        lang_instruction = _LANG_INSTRUCTIONS.get(lang, f"Respond entirely in {lang}.")
    else:
        lang_instruction = "Respond entirely in English, even when sources are in another language."

    system = (
        "You are a research assistant. Summarize the provided web search results into a clear, "
        "coherent briefing. Organize by theme/subject; for each, state the key facts, named "
        "players, figures and dates. Note where sources agree or contradict each other. Cite "
        "sources inline by their [N] tag. Use markdown: bold subject headers and concise bullet "
        "points. Do not invent facts beyond what the results state. " + lang_instruction
    )
    user = (
        f"Search query: {body.query or '(unspecified)'}\n\n"
        f"Summarize these {len(used)} web search results:\n\n{context}"
    )

    try:
        text = await call_ai(system=system, user=user, max_tokens=2000, db=db)
    except Exception as exc:
        logger.error("[search] summarize AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    return {"summary": text, "count": len(used), "truncated": len(results) > len(used)}
