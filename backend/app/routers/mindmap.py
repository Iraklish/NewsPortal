import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Article, MindMap
from ..schemas import MindMapOut, MindMapRequest
from ..services.ai_client import call_ai, call_ai_grounded, get_current_ai_settings
from ..services.search_service import multi_engine_search

router = APIRouter()
logger = logging.getLogger(__name__)


def _fetch_grounding_articles(db: Session, body: MindMapRequest) -> list[Article]:
    """Pull DB articles matching the optional category/tag/keyword/time-window filters.

    Returns the newest `max_articles` so the mind map can be grounded in real,
    recent developments rather than the model's parametric knowledge alone.
    Returns an empty list when no filters are set.
    """
    if not (body.category or body.tag or body.keyword or body.time_window_hours):
        return []

    query = db.query(Article)
    if body.category:
        query = query.filter(Article.category == body.category.strip().lower())
    if body.tag:
        query = query.filter(
            text("EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE value = :tv)").bindparams(tv=body.tag)
        )
    if body.keyword:
        kw = f"%{body.keyword.strip()}%"
        query = query.filter(
            or_(
                Article.title.ilike(kw),
                Article.summary.ilike(kw),
                Article.content.ilike(kw),
            )
        )
    if body.time_window_hours and body.time_window_hours > 0:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=body.time_window_hours)
        query = query.filter(func.coalesce(Article.published_at, Article.fetched_at) >= cutoff)

    cap = max(1, min(int(body.max_articles or 30), 80))
    effective_date = func.coalesce(Article.published_at, Article.fetched_at)
    return query.order_by(effective_date.desc(), Article.id.desc()).limit(cap).all()


def _build_grounding_block(articles: list[Article]) -> str:
    """Render grounding articles as a compact, numbered evidence list for the prompt."""
    if not articles:
        return ""
    lines: list[str] = []
    for i, a in enumerate(articles, 1):
        title = (a.title or "").strip() or "(untitled)"
        snippet = (a.summary or a.content or "").strip().replace("\n", " ")
        if len(snippet) > 300:
            snippet = snippet[:300] + "…"
        date = ""
        d = a.published_at or a.fetched_at
        if d:
            date = f" ({d.strftime('%Y-%m-%d')})"
        src = f" — {a.source}" if a.source else ""
        lines.append(f"{i}. {title}{date}{src}\n   {snippet}")
    joined = "\n".join(lines)
    return (
        "\n\nGROUND YOUR ANALYSIS in these REAL recent news items relevant to the subject. "
        "Treat them as primary evidence — reference specific developments, named players, and "
        "figures from them where they inform a dimension. Do not invent facts that contradict them:\n\n"
        f"{joined}\n"
    )


def _build_web_block(web_results: list[dict]) -> str:
    """Format explicit multi-engine web search results into a numbered evidence block."""
    if not web_results:
        return ""
    lines: list[str] = ["\n\n=== LIVE WEB SEARCH RESULTS ==="]
    for i, r in enumerate(web_results, 1):
        excerpt = ""
        if r.get("content_excerpt"):
            excerpt = f"\n    Excerpt: {r['content_excerpt'][:1000]}"
        lines.append(
            f"[WEB-{i}] {r.get('title') or '(no title)'}\n"
            f"    Source: {r.get('source') or 'web'} | Published: {r.get('published_at') or 'unknown'}\n"
            f"    URL: {r.get('url')}\n"
            f"    Snippet: {r.get('snippet') or ''}{excerpt}"
        )
    lines.append(
        "\nUse these live web results as fresh evidence. Reference specific developments and "
        "figures from them where they inform a dimension.\n"
    )
    return "\n".join(lines)


def _build_mindmap_prompt(subject: str, aspects: list[str], grounding: str = "") -> str:
    aspects_str = ", ".join(aspects)
    return f"""You are a professional systems analyst. Build a comprehensive mind map analysis of: "{subject}"
across these dimensions: {aspects_str}.{grounding}

WRITING RULES:
- Plain English. Concrete and specific. Use numbers, named players, dates when relevant.
- Every "summary" must be 2-3 full sentences.
- Every "reasoning" must explain WHY in 1-2 sentences (cause → effect chain).
- "whyItMatters" explains the practical stake in 1-2 sentences.
- "items" must be self-contained sentences a reader can understand without context.

Return ONLY a JSON object with this exact shape:
{{
  "subject": "{subject}",
  "summary": "2-3 sentence synthesis of the situation as it stands today.",
  "reasoning": "1-2 sentences on the underlying logic driving the system.",
  "whyItMatters": "1-2 sentences on the practical stake for an investor / policymaker / informed citizen.",
  "outcome": "1-2 sentences naming the most likely strategic outcome and the dominant driver behind it.",
  "prognosis": {{
    "shortTerm": "1-6 month outlook in 1-2 sentences, with a specific signal to watch.",
    "longTerm": "6-24 month outlook in 1-2 sentences, with a specific signal to watch."
  }},
  "aspects": {{
    "AspectName": {{
      "summary": "2-3 sentences explaining how this aspect specifically shapes the subject.",
      "reasoning": "1-2 sentences on the causal mechanism.",
      "whyItMatters": "1 sentence on the stake.",
      "categories": [
        {{ "kind": "Characteristics", "explanation": "1 sentence framing.", "items": ["Self-contained fact.", "Another fact."] }},
        {{ "kind": "Metrics", "explanation": "1 sentence framing.", "items": ["Specific metric with value or direction.", "Another metric."] }},
        {{ "kind": "Impacts", "explanation": "1 sentence framing.", "items": ["Concrete impact on a named actor.", "Another impact."] }},
        {{ "kind": "Factors", "explanation": "1 sentence framing.", "items": ["Named driver and how it moves the system.", "Another driver."] }}
      ]
    }}
  }}
}}

Include an entry in "aspects" for EACH of: {aspects_str}
"""


def _parse_json(raw: str) -> dict:
    s = re.sub(r"```(?:json)?\s*", "", raw).replace("```", "")
    first, last = s.find("{"), s.rfind("}")
    if first == -1 or last == -1:
        raise ValueError("No JSON object in response")
    s = s[first : last + 1]
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    return json.loads(s)


@router.get("", response_model=list[MindMapOut])
def list_mindmaps(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    return (
        db.query(MindMap)
        .order_by(MindMap.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.post("/generate", response_model=MindMapOut)
async def generate_mindmap(body: MindMapRequest, db: Session = Depends(get_db)):
    provider, model = await get_current_ai_settings(db)
    grounding_articles = _fetch_grounding_articles(db, body)
    grounding = _build_grounding_block(grounding_articles)
    if grounding:
        logger.info(
            "[mindmap] grounding on %d article(s) (category=%s tag=%s keyword=%s window=%sh)",
            len(grounding_articles), body.category, body.tag, body.keyword, body.time_window_hours,
        )

    # Explicit multi-engine web search (Google / DDG / Bing) — runs first if requested.
    web_block = ""
    if body.include_web_search:
        try:
            web_results = await multi_engine_search(body.subject, db=db, num=8)
            web_block = _build_web_block(web_results)
            logger.info("[mindmap] explicit web search returned %d result(s)", len(web_results))
        except Exception as exc:
            logger.warning("[mindmap] explicit web search failed: %s", exc)

    prompt = _build_mindmap_prompt(body.subject, body.aspects, grounding + web_block)

    system = "You are a systems analysis expert. Return only valid JSON with no prose outside the JSON object."

    try:
        if body.include_web:
            # AI-native grounding: let the provider use its built-in web search.
            system_grounded = (
                system
                + " ADDITIONALLY: Use your built-in web search to ground the analysis in the "
                "latest real-world developments, named players, and figures."
            )
            grounded = await call_ai_grounded(
                system=system_grounded,
                user=prompt,
                max_tokens=4096,
                db=db,
            )
            raw = grounded.text
            logger.info(
                "[mindmap] AI-native grounding used=%s, %d citation(s)",
                grounded.provider_used_grounding, len(grounded.citations or []),
            )
        else:
            raw = await call_ai(
                system=system,
                user=prompt,
                max_tokens=4096,
                db=db,
            )
        map_data = _parse_json(raw)
    except Exception as exc:
        logger.error("MindMap generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Generation failed: {exc}")

    mm = MindMap(
        subject=body.subject,
        aspects=body.aspects,
        model_used=model,
        map_data=map_data,
    )
    db.add(mm)
    db.commit()
    db.refresh(mm)
    return mm


@router.get("/{mindmap_id}", response_model=MindMapOut)
def get_mindmap(mindmap_id: int, db: Session = Depends(get_db)):
    mm = db.query(MindMap).filter(MindMap.id == mindmap_id).first()
    if not mm:
        raise HTTPException(status_code=404, detail="MindMap not found")
    return mm


@router.delete("/{mindmap_id}")
def delete_mindmap(mindmap_id: int, db: Session = Depends(get_db)):
    mm = db.query(MindMap).filter(MindMap.id == mindmap_id).first()
    if not mm:
        raise HTTPException(status_code=404, detail="MindMap not found")
    db.delete(mm)
    db.commit()
    return {"deleted": True, "id": mindmap_id}
