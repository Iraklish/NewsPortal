import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import DEFAULT_ASK_SYSTEM_PROMPT, DEFAULT_CHAT_SYSTEM_PROMPT
from ..database import get_db
from ..models import Analysis, AppSettings, Article, DirectedReport
from ..schemas import (
    AnalysisOut,
    ArticleAskRequest,
    ChatRequest,
    DirectedAnalysisRequest,
    DirectedReportOut,
    DirectedReportRequest,
)
from ..services.analyzer import analyze_article, run_directed_analysis
from ..services.ai_client import call_ai, call_ai_grounded
from ..services.directed_report import count_db_articles, run_directed_report


def _get_prompt(db: Session, key: str, default: str) -> str:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row and row.value and row.value.strip():
        return row.value
    return default

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("", response_model=list[AnalysisOut])
def list_analyses(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    article_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(Analysis)
    if article_id is not None:
        query = query.filter(Analysis.article_id == article_id)
    return (
        query.order_by(Analysis.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


# NOTE: fixed-path routes must be declared BEFORE /{analysis_id} so that
# "reports" doesn't get parsed as an int.

@router.get("/reports", response_model=list[DirectedReportOut])
def list_reports(
    skip: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    return (
        db.query(DirectedReport)
        .order_by(DirectedReport.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.get("/reports/{report_id}", response_model=DirectedReportOut)
def get_report(report_id: int, db: Session = Depends(get_db)):
    r = db.query(DirectedReport).filter(DirectedReport.id == report_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    return r


@router.delete("/reports/{report_id}")
def delete_report(report_id: int, db: Session = Depends(get_db)):
    r = db.query(DirectedReport).filter(DirectedReport.id == report_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    db.delete(r)
    db.commit()
    return {"deleted": True, "id": report_id}


@router.get("/{analysis_id}", response_model=AnalysisOut)
def get_analysis(analysis_id: int, db: Session = Depends(get_db)):
    analysis = db.query(Analysis).filter(Analysis.id == analysis_id).first()
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return analysis


@router.delete("/{analysis_id}")
def delete_analysis(analysis_id: int, db: Session = Depends(get_db)):
    analysis = db.query(Analysis).filter(Analysis.id == analysis_id).first()
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    db.delete(analysis)
    db.commit()
    return {"deleted": True, "id": analysis_id}


@router.post("/article/{article_id}", response_model=AnalysisOut)
async def analyze_single_article(
    article_id: int,
    focus: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    try:
        result = await analyze_article(article, db, focus=focus)
    except Exception as exc:
        logger.error("Analysis failed for article %s: %s", article_id, exc)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}")

    # Return the ORM object for response_model serialization
    analysis = db.query(Analysis).filter(Analysis.id == result["id"]).first()
    return analysis


@router.get("/directed/preview")
def directed_preview(
    focus: str = Query(..., min_length=1),
    time_window_hours: int = Query(24, ge=1, le=24 * 365),
    db: Session = Depends(get_db),
):
    """Cheap count of DB articles matching focus + window — for the UI preview."""
    return {"db_article_count": count_db_articles(focus.strip(), db, time_window_hours)}


@router.post("/directed", response_model=DirectedReportOut)
async def directed_report(
    body: DirectedReportRequest,
    db: Session = Depends(get_db),
):
    """Synthesize one consolidated report from DB articles + live web search."""
    try:
        report = await run_directed_report(
            focus=body.focus,
            db=db,
            include_web=body.include_web,
            include_web_search=body.include_web_search,
            time_window_hours=body.time_window_hours,
            max_web_results=body.max_web_results,
            fetch_web_content=body.fetch_web_content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Directed report generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Report generation failed: {exc}")
    return report


# Legacy per-article batch endpoint (kept for compatibility)
@router.post("/directed-batch")
async def directed_analysis_batch(
    body: DirectedAnalysisRequest,
    db: Session = Depends(get_db),
):
    try:
        results = await run_directed_analysis(
            focus=body.focus,
            db=db,
            max_articles=body.max_articles,
        )
    except Exception as exc:
        logger.error("Directed batch analysis failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed: {exc}")
    return {"message": f"Analyzed {len(results)} articles", "analyses": results, "count": len(results)}


@router.post("/article/{article_id}/ask")
async def ask_about_article(
    article_id: int,
    body: ArticleAskRequest,
    db: Session = Depends(get_db),
):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    analyses = (
        db.query(Analysis)
        .filter(Analysis.article_id == article_id)
        .order_by(Analysis.created_at.desc())
        .limit(5)
        .all()
    )

    analysis_context = ""
    for a in analyses:
        focus_label = f" (focus: {a.focus})" if a.focus else ""
        bits = []
        if a.summary:
            bits.append(f"Summary: {a.summary}")
        if a.impact_type:
            bits.append(f"Impact: {a.impact_type}")
        if a.economic_impact:
            bits.append(f"Economic: {a.economic_impact}")
        if a.market_analysis:
            bits.append(f"Market: {a.market_analysis}")
        if a.geopolitical_factors:
            bits.append(f"Geopolitical: {a.geopolitical_factors}")
        if a.risk_assessment:
            bits.append(f"Risks: {a.risk_assessment}")
        if a.opportunities:
            bits.append(f"Opportunities: {a.opportunities}")
        analysis_context += f"\n--- Prior analysis{focus_label} ---\n" + "\n".join(bits) + "\n"

    content = (article.content or article.summary or "")[:6000]
    base_prompt = _get_prompt(db, "ask_system_prompt", DEFAULT_ASK_SYSTEM_PROMPT)
    system = (
        f"{base_prompt}\n\n"
        f"ARTICLE\n"
        f"Title: {article.title or '(no title)'}\n"
        f"Source: {article.source or 'unknown'}\n"
        f"Published: {article.published_at or 'unknown'}\n"
        f"URL: {article.url}\n\n"
        f"{content}\n"
        f"{analysis_context}"
    )

    history_lines = [f"{m.role.capitalize()}: {m.content}" for m in body.history[-10:]]
    user_prompt = body.question
    if history_lines:
        user_prompt = "Conversation so far:\n" + "\n".join(history_lines) + f"\n\nCurrent question: {body.question}"

    try:
        response_text = await call_ai(system=system, user=user_prompt, max_tokens=1200, db=db)
    except Exception as exc:
        logger.error("Ask-article AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    return {"response": response_text}


_NEED_WEB_MARKER = "[NEED_WEB]"
_SUGGEST_MARKER = "SUGGEST_SEARCH:"


def _gather_chat_articles(message: str, db: Session, limit: int = 25) -> list[Article]:
    """Find articles relevant to the user's message via keyword scan.

    Falls back to the latest articles when no useful keywords are present, so
    the chat never starts cold.
    """
    raw_terms = re.findall(r"[A-Za-zÀ-ɏЀ-ӿ֐-׿]{3,}", message)
    stopwords = {
        "the", "and", "for", "with", "that", "this", "from", "have", "what", "who", "why",
        "how", "are", "was", "were", "will", "did", "did", "you", "your", "tell", "about",
        "today", "yesterday", "any", "news", "news?", "latest", "give", "show", "summary",
    }
    keywords = [kw.lower() for kw in raw_terms if kw.lower() not in stopwords]
    # Dedupe while preserving order
    seen: set[str] = set()
    keywords = [kw for kw in keywords if not (kw in seen or seen.add(kw))][:8]

    query = db.query(Article)
    if keywords:
        conditions = []
        for kw in keywords:
            pat = f"%{kw}%"
            conditions.append(Article.title.ilike(pat))
            conditions.append(Article.summary.ilike(pat))
            conditions.append(Article.content.ilike(pat))
        query = query.filter(or_(*conditions))

    rows = (
        query.order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
        .limit(limit)
        .all()
    )
    # If keywords matched nothing, fall back to the latest articles so the chat
    # at least sees the freshest news.
    if not rows:
        rows = (
            db.query(Article)
            .order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
            .limit(limit)
            .all()
        )
    return rows


def _build_articles_context(articles: list[Article]) -> tuple[str, list[dict]]:
    if not articles:
        return "(No articles in the local database yet.)", []
    refs: list[dict] = []
    blocks: list[str] = []
    for i, a in enumerate(articles, 1):
        published = a.published_at.isoformat() if a.published_at else "unknown"
        excerpt = (a.summary or a.content or "")[:600]
        blocks.append(
            f"[A-{i}] {a.title or '(no title)'}\n"
            f"    Source: {a.source or 'unknown'} | Published: {published} | Category: {a.category or '-'}\n"
            f"    {excerpt}"
        )
        refs.append({
            "kind": "article",
            "id": a.id,
            "title": a.title,
            "url": a.url,
            "source": a.source,
            "published_at": published,
            "snippet": (a.summary or excerpt[:200]) if (a.summary or excerpt) else None,
        })
    return "\n\n".join(blocks), refs


def _parse_chat_response(raw: str) -> tuple[str, Optional[str], bool]:
    """Strip out our internal markers from the AI text and pull out:
        - text: the user-visible response with markers removed
        - suggested_query: SUGGEST_SEARCH line if present
        - needs_web: True if the model explicitly flagged it has no answer
    Robust against the marker appearing mid-line (we saw the AI leak it).
    """
    text = raw or ""
    suggested: Optional[str] = None
    needs_web = False

    # NEED_WEB: pull out and clear; treat as a soft signal (we'll still keep
    # whatever non-marker text the model produced).
    nw_match = re.search(rf"{re.escape(_NEED_WEB_MARKER)}\s*([^\n]*)", text)
    if nw_match:
        needs_web = True
        q = nw_match.group(1).strip()
        if q:
            suggested = q
        text = (text[:nw_match.start()] + text[nw_match.end():]).strip()

    # SUGGEST_SEARCH overrides any NEED_WEB query (it's the friendlier path).
    ss_match = re.search(rf"{re.escape(_SUGGEST_MARKER)}\s*([^\n]+)", text)
    if ss_match:
        suggested = ss_match.group(1).strip(" .\"'")
        text = (text[:ss_match.start()] + text[ss_match.end():]).strip()

    # Clean up trailing blank lines / leftover whitespace
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text, suggested, needs_web


@router.post("/chat")
async def chat(body: ChatRequest, db: Session = Depends(get_db)):
    base_prompt = _get_prompt(db, "chat_system_prompt", DEFAULT_CHAT_SYSTEM_PROMPT)

    # Build conversation history
    history_messages = [f"{m.role.capitalize()}: {m.content}" for m in body.history[-20:]]
    user_prompt = body.message
    if history_messages:
        user_prompt = "Conversation history:\n" + "\n".join(history_messages) + f"\n\nCurrent question: {body.message}"

    # ── Branch A: user already approved web search ──────────────────────────
    if body.use_web:
        query = (body.web_query or body.message).strip()
        # Still ground in the local articles too, so the AI's web research is
        # contextualized against what we already know.
        articles = _gather_chat_articles(body.message, db, limit=15)
        articles_block, article_refs = _build_articles_context(articles)
        system = (
            f"{base_prompt}\n\n"
            f"=== LOCAL ARTICLES ({len(articles)}) ===\n{articles_block}\n\n"
            f"The user wants you to also research \"{query}\" on the web. "
            f"Combine the articles above with your built-in web search. "
            f"Cite local articles as [A-N] and web sources by URL inline."
        )

        try:
            grounded = await call_ai_grounded(system=system, user=user_prompt, max_tokens=2000, db=db)
        except Exception as exc:
            logger.error("Chat AI (grounded) call failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

        text, _, _ = _parse_chat_response(grounded.text)
        web_refs = [
            {"kind": "web", "title": c.title, "url": c.url, "source": None, "snippet": c.snippet}
            for c in grounded.citations if c.url
        ]
        if not grounded.provider_used_grounding:
            text = (
                "_(Your current AI provider doesn't support web grounding. "
                "Switch to Gemini or Anthropic in Settings to enable live search.)_\n\n"
                + text
            )
        return {
            "response": text,
            "references": article_refs + web_refs,
            "used_web": True,
        }

    # ── Branch B: normal chat — answer from local articles, always suggest a follow-up search ──
    articles = _gather_chat_articles(body.message, db, limit=25)
    articles_block, article_refs = _build_articles_context(articles)

    system = (
        f"{base_prompt}\n\n"
        f"You have {len(articles)} local article(s) below. Treat them as your primary source.\n\n"
        f"=== LOCAL ARTICLES ===\n{articles_block}\n\n"
        f"INSTRUCTIONS:\n"
        f"• Answer the user's question grounded in the articles above. Cite specific ones with [A-N] tags inline.\n"
        f"• If the articles do not cover the question, say so plainly and use prior general knowledge.\n"
        f"• On the LAST line, output a follow-up web search query that would enrich the answer, formatted EXACTLY as:\n"
        f"  {_SUGGEST_MARKER} <one short Google-style query>\n"
        f"• Only use {_NEED_WEB_MARKER} INSTEAD of a normal answer when the question fundamentally "
        f"requires fresh/external data (e.g. live prices, breaking news) AND the articles say nothing useful. "
        f"Don't use {_NEED_WEB_MARKER} when local articles contain even partial relevant info — just answer."
    )

    try:
        raw = await call_ai(system=system, user=user_prompt, max_tokens=1500, db=db)
    except Exception as exc:
        logger.error("Chat AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    text, suggested_query, needs_web_flag = _parse_chat_response(raw)

    if needs_web_flag and not text:
        # Truly no answer — show the explicit approval card
        q = suggested_query or body.message
        return {
            "response": f"I don't have enough information in the local articles to answer this confidently.\n\nMay I search the web for: **{q}**?",
            "needs_web": True,
            "web_query": q,
            "references": article_refs,
        }

    return {
        "response": text,
        "references": article_refs,
        "suggested_web_query": suggested_query,
    }
