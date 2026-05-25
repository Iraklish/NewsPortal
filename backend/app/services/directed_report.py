"""Synthesize a rich, multi-source directed report.

Sources:
  1. Recent DB articles matching focus keywords (always)
  2. AI-native grounding (Gemini/Anthropic built-in web search) when include_web=True
Then asks the AI to produce a single structured synthesis with citations.
"""
import json
import logging
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from ..models import Article, DirectedReport
from .ai_client import call_ai, call_ai_grounded, get_current_ai_settings

logger = logging.getLogger(__name__)

_IMPACT_LEVELS = {"highly_positive", "positive", "neutral", "negative", "highly_negative"}


# ── Context gathering ────────────────────────────────────────────────────────

def _gather_db_articles(focus: str, db: Session, hours: int, hard_cap: int = 200) -> list[Article]:
    """Match articles by any focus keyword within the last `hours`, sorted by recency.

    `hard_cap` is a safety ceiling so a wildly popular topic doesn't blow the prompt.
    """
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
    keywords = [kw.strip() for kw in focus.split() if len(kw.strip()) > 2]
    query = db.query(Article)
    # Time window: prefer published_at when present, fall back to fetched_at.
    query = query.filter(
        or_(
            and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
            and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
        )
    )
    if keywords:
        conditions = []
        for kw in keywords:
            conditions.append(Article.title.ilike(f"%{kw}%"))
            conditions.append(Article.content.ilike(f"%{kw}%"))
            conditions.append(Article.summary.ilike(f"%{kw}%"))
        query = query.filter(or_(*conditions))
    return (
        query.order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
        .limit(hard_cap)
        .all()
    )


def count_db_articles(focus: str, db: Session, hours: int) -> int:
    """Lightweight count of DB articles matching focus in window (no row fetch)."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
    keywords = [kw.strip() for kw in focus.split() if len(kw.strip()) > 2]
    query = db.query(Article.id).filter(
        or_(
            and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
            and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
        )
    )
    if keywords:
        conditions = []
        for kw in keywords:
            conditions.append(Article.title.ilike(f"%{kw}%"))
            conditions.append(Article.content.ilike(f"%{kw}%"))
            conditions.append(Article.summary.ilike(f"%{kw}%"))
        query = query.filter(or_(*conditions))
    return query.count()


# ── Prompt construction ──────────────────────────────────────────────────────

def _build_context_block(db_articles: list[Article], web_results: list[dict]) -> tuple[str, list[dict]]:
    """Return (context_text, references_list)."""
    refs: list[dict] = []
    blocks: list[str] = []

    if db_articles:
        blocks.append("=== EXISTING NEWS (from local database) ===")
        for i, a in enumerate(db_articles, 1):
            published = a.published_at.isoformat() if a.published_at else "unknown"
            excerpt = (a.content or a.summary or "")[:1200]
            blocks.append(
                f"[DB-{i}] {a.title or '(no title)'}\n"
                f"    Source: {a.source or 'unknown'} | Published: {published}\n"
                f"    URL: {a.url}\n"
                f"    Excerpt: {excerpt}\n"
            )
            refs.append({
                "kind": "db",
                "title": a.title,
                "url": a.url,
                "source": a.source,
                "published_at": published,
                "snippet": (a.summary or excerpt[:200]) if (a.summary or excerpt) else None,
            })

    if web_results:
        blocks.append("\n=== LIVE WEB SEARCH RESULTS ===")
        for i, r in enumerate(web_results, 1):
            content_block = ""
            if r.get("content_excerpt"):
                content_block = f"\n    Excerpt: {r['content_excerpt'][:1500]}"
            blocks.append(
                f"[WEB-{i}] {r.get('title') or '(no title)'}\n"
                f"    Source: {r.get('source') or 'web'} | Published: {r.get('published_at') or 'unknown'}\n"
                f"    URL: {r.get('url')}\n"
                f"    Snippet: {r.get('snippet') or ''}{content_block}\n"
            )
            refs.append({
                "kind": "web",
                "title": r.get("title"),
                "url": r.get("url"),
                "source": r.get("source"),
                "published_at": r.get("published_at"),
                "snippet": r.get("snippet"),
            })

    return "\n".join(blocks), refs


def _build_prompts(focus: str, context_text: str) -> tuple[str, str]:
    system = (
        "You are a senior economic, financial and geopolitical analyst. "
        "Synthesize a coherent, evidence-grounded report from multiple sources. "
        "Cite specific items from the context by their [DB-N] / [WEB-N] tags inline where appropriate. "
        "Be concrete: use numbers, named players, dates, sectors. Avoid hedging fluff. "
        "Acknowledge contradictions between sources rather than glossing over them. "
        "Respond with ONLY a single valid JSON object — no markdown, no surrounding prose."
    )

    user = f"""Topic of focus: "{focus}"

Synthesize the following sources into ONE consolidated analysis. Do not analyze each source separately — produce a single integrated report.

{context_text}

Return a JSON object with exactly these fields:

{{
  "headline": "one-line synthesis (max 120 chars) capturing the situation",
  "executive_summary": "3-5 sentence overview of what is happening and why it matters",
  "key_developments": ["specific development with [DB-N] / [WEB-N] citation", "another", "..."],
  "economic_impact": "concrete economic implications, 2-4 sentences with figures/sectors named",
  "market_impact": "implications for equities/bonds/FX/commodities, with named tickers or assets when relevant",
  "geopolitical_impact": "geopolitical implications, named state/non-state actors",
  "sector_impact": {{ "SectorName": "one-sentence sector-specific implication" }},
  "risk_assessment": "top 2-4 risks, each with the channel through which it would materialize",
  "opportunities": "top 2-4 opportunities with concrete actionable angles",
  "contrarian_views": "what mainstream coverage gets wrong, or under-appreciated angle",
  "prognosis_short": "1-6 month outlook in 2-3 sentences. End with a specific signal/metric to watch.",
  "prognosis_long": "6-24 month outlook in 2-3 sentences. End with a specific signal/metric to watch.",
  "signals_to_watch": ["concrete leading indicator 1", "indicator 2", "indicator 3"],
  "impact_type": "one of: highly_positive | positive | neutral | negative | highly_negative",
  "confidence_score": 0.0_to_1.0
}}"""
    return system, user


def _parse_json(raw: str) -> dict:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1:
        cleaned = cleaned[start : end + 1]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.warning("Failed to parse directed report JSON: %s; raw: %.200s", exc, raw)
        return {}


# ── Public entry point ──────────────────────────────────────────────────────

async def run_directed_report(
    focus: str,
    db: Session,
    include_web: bool = True,
    include_web_search: bool = False,   # explicit multi-engine search (Google/DDG/Bing)
    time_window_hours: int = 24,
    max_web_results: int = 6,           # kept for API back-compat; ignored under grounding
    fetch_web_content: bool = False,    # kept for API back-compat; ignored under grounding
) -> DirectedReport:
    """Build context, synthesize, persist, return the DirectedReport row.

    With AI-native grounding, the model itself decides what to search and reports
    citations alongside the synthesis. We feed it the DB articles for grounding in
    your own corpus, and let it pull live web data on its own.

    include_web_search=True forces an explicit multi-engine search (Google CSE /
    DuckDuckGo / Bing) and injects the results as [WEB-N] context blocks before
    calling the AI — regardless of whether native grounding is also enabled.
    """
    focus = focus.strip()
    if not focus:
        raise ValueError("focus is required")

    db_articles = _gather_db_articles(focus, db, time_window_hours)
    if not db_articles and not include_web and not include_web_search:
        raise ValueError("No DB articles match this focus in the chosen window; enable web grounding or web search, or widen the window")

    # ── Step 0: explicit web search (always runs when requested) ─────────────
    explicit_web_results: list[dict] = []
    if include_web_search:
        from .search_service import multi_engine_search
        logger.info("[report] running explicit web search for '%s'", focus[:80])
        explicit_web_results = await multi_engine_search(focus, db=db, num=8)
        logger.info("[report] explicit web search: %d result(s)", len(explicit_web_results))

    # Build initial context (DB articles + any explicit web results)
    context_text, references = _build_context_block(db_articles, explicit_web_results)
    system, user = _build_prompts(focus, context_text)

    grounded_used = False
    if include_web:
        # ── Step 1: attempt AI-native grounding ─────────────────────────────
        system_grounded = (
            system
            + "\n\nADDITIONALLY: Use your built-in web search to find current information "
            f"about \"{focus}\" beyond the database context. Combine both sources into one "
            "coherent synthesis."
        )
        grounded = await call_ai_grounded(system=system_grounded, user=user, max_tokens=4000, db=db)
        raw = grounded.text
        grounded_used = grounded.provider_used_grounding

        # Append the model-reported web citations to our references list.
        for c in grounded.citations:
            if not c.url:
                continue
            references.append({
                "kind": "web",
                "title": c.title,
                "url": c.url,
                "source": None,
                "published_at": None,
                "snippet": c.snippet,
            })

        # ── Step 2: fallback to direct search when grounding yields nothing ─
        # Only run if we didn't already inject explicit web results.
        if not grounded.citations and not explicit_web_results:
            logger.info(
                "[report] grounding returned 0 web citations for '%s' — running search fallback",
                focus[:80],
            )
            from .search_service import multi_engine_search
            fallback_results = await multi_engine_search(focus, db=db, num=8)
            if fallback_results:
                logger.info(
                    "[report] search fallback: %d result(s) — rebuilding context and re-calling AI",
                    len(fallback_results),
                )
                # Rebuild context so the AI sees web snippets as [WEB-N] blocks it can cite.
                context_text, references = _build_context_block(db_articles, fallback_results)
                system, user = _build_prompts(focus, context_text)
                raw = await call_ai(system=system, user=user, max_tokens=4000, db=db)
            else:
                logger.warning(
                    "[report] search fallback also returned 0 results for '%s'; "
                    "report will be based on DB articles only",
                    focus[:80],
                )
    else:
        raw = await call_ai(system=system, user=user, max_tokens=4000, db=db)

    data = _parse_json(raw)

    impact_type = data.get("impact_type", "neutral")
    if impact_type not in _IMPACT_LEVELS:
        impact_type = "neutral"

    _, model_name = await get_current_ai_settings(db)

    report = DirectedReport(
        focus=focus,
        model_used=model_name,
        headline=data.get("headline", ""),
        executive_summary=data.get("executive_summary", ""),
        key_developments=data.get("key_developments", []) or [],
        economic_impact=data.get("economic_impact", ""),
        market_impact=data.get("market_impact", ""),
        geopolitical_impact=data.get("geopolitical_impact", ""),
        sector_impact=data.get("sector_impact", {}) or {},
        risk_assessment=data.get("risk_assessment", ""),
        opportunities=data.get("opportunities", ""),
        contrarian_views=data.get("contrarian_views", ""),
        prognosis_short=data.get("prognosis_short", ""),
        prognosis_long=data.get("prognosis_long", ""),
        signals_to_watch=data.get("signals_to_watch", []) or [],
        confidence_score=float(data.get("confidence_score", 0.0)),
        impact_type=impact_type,
        references=references,
        db_article_count=len(db_articles),
        web_result_count=sum(1 for r in references if r.get("kind") == "web"),
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
