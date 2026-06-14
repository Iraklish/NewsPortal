import json
import logging
import re
from typing import Optional

from sqlalchemy.orm import Session

from ..models import Analysis, Article
from .ai_client import call_ai, get_ai_settings_for_task

logger = logging.getLogger(__name__)

_IMPACT_LEVELS = {"highly_positive", "positive", "neutral", "negative", "highly_negative"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _empty_analysis() -> dict:
    return {
        "summary": "",
        "impact_type": "neutral",
        "economic_impact": "",
        "market_analysis": "",
        "geopolitical_factors": "",
        "risk_assessment": "",
        "opportunities": "",
        "prognosis_short": "",
        "prognosis_long": "",
        "key_indicators": [],
        "affected_sectors": [],
        "affected_regions": [],
        "categories": {},
        "confidence_score": 0.0,
    }


def _parse_json_response(raw: str) -> dict:
    """Safely extract JSON from an AI response that may include markdown fences."""
    # Strip ```json ... ``` fences
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()

    # Try to find the first { ... } block
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1:
        cleaned = cleaned[start : end + 1]

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.warning("JSON decode failed: %s — raw snippet: %.200s", exc, raw)
        return {}


def _build_analysis_prompt(article: Article, focus: Optional[str] = None) -> tuple[str, str]:
    title = article.title or "(no title)"
    source = article.source or "unknown source"
    content = (article.content or article.summary or "")[:6000]
    published = str(article.published_at) if article.published_at else "unknown date"

    focus_instruction = ""
    if focus:
        focus_instruction = f"\n\nFocus your analysis specifically on: {focus}"

    system = (
        "You are an expert economic and financial analyst. "
        "You analyze news articles and provide structured economic intelligence. "
        "Always respond with valid JSON only — no markdown, no explanations outside the JSON."
        + focus_instruction
    )

    user = f"""Analyze the following news article and return a JSON object with exactly these fields:

{{
  "summary": "2-3 sentence summary of the article",
  "impact_type": "one of: highly_positive | positive | neutral | negative | highly_negative",
  "economic_impact": "detailed analysis of economic impact",
  "market_analysis": "analysis of market implications",
  "geopolitical_factors": "geopolitical context and factors",
  "risk_assessment": "key risks identified",
  "opportunities": "opportunities arising from this development",
  "prognosis_short": "1-6 month outlook",
  "prognosis_long": "6-24 month outlook",
  "key_indicators": ["list", "of", "key", "economic", "indicators", "to", "watch"],
  "affected_sectors": ["list", "of", "affected", "industry", "sectors"],
  "affected_regions": ["list", "of", "affected", "geographic", "regions"],
  "categories": {{
    "CategoryName": ["point 1", "point 2"]
  }},
  "confidence_score": 0.85
}}

Article details:
Title: {title}
Source: {source}
Published: {published}
Content:
{content}
"""
    return system, user


# ── Main analyzer ─────────────────────────────────────────────────────────────

async def analyze_article(article: Article, db: Session, focus: Optional[str] = None) -> dict:
    """Analyze a single article and persist the Analysis record. Returns the analysis dict."""
    system, user = _build_analysis_prompt(article, focus)

    provider, model_name = await get_ai_settings_for_task("analyze", db)
    try:
        raw = await call_ai(system=system, user=user, max_tokens=3000, provider=provider, model=model_name, db=db)
        data = _parse_json_response(raw)
    except Exception as exc:
        logger.error("AI call failed for article %s: %s", article.id, exc)
        data = {}

    if not data:
        data = _empty_analysis()

    # Validate impact_type
    impact_type = data.get("impact_type", "neutral")
    if impact_type not in _IMPACT_LEVELS:
        impact_type = "neutral"

    analysis = Analysis(
        article_id=article.id,
        focus=focus,
        model_used=model_name,
        summary=data.get("summary", ""),
        impact_type=impact_type,
        economic_impact=data.get("economic_impact", ""),
        market_analysis=data.get("market_analysis", ""),
        geopolitical_factors=data.get("geopolitical_factors", ""),
        risk_assessment=data.get("risk_assessment", ""),
        opportunities=data.get("opportunities", ""),
        prognosis_short=data.get("prognosis_short", ""),
        prognosis_long=data.get("prognosis_long", ""),
        key_indicators=data.get("key_indicators", []),
        affected_sectors=data.get("affected_sectors", []),
        affected_regions=data.get("affected_regions", []),
        categories=data.get("categories", {}),
        confidence_score=float(data.get("confidence_score", 0.0)),
    )

    db.add(analysis)
    article.is_analyzed = True
    db.commit()
    db.refresh(analysis)

    return {
        "id": analysis.id,
        "article_id": analysis.article_id,
        "created_at": analysis.created_at,
        "focus": analysis.focus,
        "model_used": analysis.model_used,
        "summary": analysis.summary,
        "impact_type": analysis.impact_type,
        "economic_impact": analysis.economic_impact,
        "market_analysis": analysis.market_analysis,
        "geopolitical_factors": analysis.geopolitical_factors,
        "risk_assessment": analysis.risk_assessment,
        "opportunities": analysis.opportunities,
        "prognosis_short": analysis.prognosis_short,
        "prognosis_long": analysis.prognosis_long,
        "key_indicators": analysis.key_indicators,
        "affected_sectors": analysis.affected_sectors,
        "affected_regions": analysis.affected_regions,
        "categories": analysis.categories,
        "confidence_score": analysis.confidence_score,
    }


async def run_directed_analysis(focus: str, db: Session, max_articles: int = 10) -> list:
    """Fetch recent articles matching focus keywords, analyze them, return analyses."""
    keywords = [kw.strip().lower() for kw in focus.split() if len(kw.strip()) > 2]

    query = db.query(Article)

    if keywords:
        from sqlalchemy import or_
        conditions = []
        for kw in keywords:
            conditions.append(Article.title.ilike(f"%{kw}%"))
            conditions.append(Article.content.ilike(f"%{kw}%"))
        query = query.filter(or_(*conditions))

    articles = (
        query.order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
        .limit(max_articles)
        .all()
    )

    results = []
    for article in articles:
        try:
            analysis_dict = await analyze_article(article, db, focus=focus)
            results.append(analysis_dict)
        except Exception as exc:
            logger.error("Directed analysis failed for article %s: %s", article.id, exc)

    return results
