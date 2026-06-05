import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, or_, text as sa_text
from sqlalchemy.orm import Session

from ..config import DEFAULT_ASK_SYSTEM_PROMPT, DEFAULT_CHAT_SYSTEM_PROMPT, DEFAULT_SUMMARY_SYSTEM_PROMPT
from ..database import get_db
from ..models import Analysis, AppSettings, Article, DirectedReport
from ..schemas import (
    AnalysisOut,
    ArticleAskRequest,
    ChatRequest,
    DirectedAnalysisRequest,
    DirectedReportListItem,
    DirectedReportOut,
    DirectedReportRequest,
    ReportAskRequest,
)
from ..services.analyzer import analyze_article, run_directed_analysis
from ..services.ai_client import call_ai, call_ai_grounded
from ..services.directed_report import count_db_articles, run_directed_report
from ..services.search_service import multi_engine_search


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


# ── Summary request schema ────────────────────────────────────────────────────

class SummaryRequest(BaseModel):
    filter_type: str = "keyword"  # "tag" | "category" | "keyword"
    filter_value: str = ""
    time_window_hours: int = 24
    max_articles: int = 50      # 0 = no hard limit (up to 5000)
    custom_prompt: Optional[str] = None  # extra instructions appended to system prompt
    language: str = ""          # "" / "English" → no change; other values → respond in that language
    article_ids: Optional[list[int]] = None  # if set, summarize exactly these articles (ignores filters/window)


class SummaryAskRequest(BaseModel):
    summary: str                # full summary text as context
    question: str
    history: list = []          # [{"role": "user"|"assistant", "content": "..."}]


# NOTE: fixed-path routes must be declared BEFORE /{analysis_id} so that
# "reports" doesn't get parsed as an int.

_REPORT_HISTORY_LIMIT = 10


def _report_description(r: DirectedReport) -> str | None:
    if r.headline:
        return r.headline
    if r.executive_summary:
        return r.executive_summary[:140] + ("…" if len(r.executive_summary) > 140 else "")
    return None


@router.get("/reports", response_model=list[DirectedReportListItem])
def list_reports(db: Session = Depends(get_db)):
    """Return the latest reports as lightweight title/description rows.

    Keeps only the most recent _REPORT_HISTORY_LIMIT reports and permanently
    deletes the rest, so history stays small and nothing heavy is preloaded.
    """
    ids = [
        rid for (rid,) in db.query(DirectedReport.id)
        .order_by(DirectedReport.created_at.desc(), DirectedReport.id.desc())
        .all()
    ]
    keep_ids = ids[:_REPORT_HISTORY_LIMIT]
    extra_ids = ids[_REPORT_HISTORY_LIMIT:]
    if extra_ids:
        db.query(DirectedReport).filter(DirectedReport.id.in_(extra_ids)).delete(synchronize_session=False)
        db.commit()
        logger.info("[reports] pruned %d old report(s), kept latest %d", len(extra_ids), len(keep_ids))

    rows = (
        db.query(DirectedReport)
        .filter(DirectedReport.id.in_(keep_ids))
        .order_by(DirectedReport.created_at.desc(), DirectedReport.id.desc())
        .all()
    )
    return [
        DirectedReportListItem(
            id=r.id,
            focus=r.focus,
            created_at=r.created_at,
            headline=_report_description(r),
            impact_type=r.impact_type,
            db_article_count=r.db_article_count,
            web_result_count=r.web_result_count,
        )
        for r in rows
    ]


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


@router.post("/reports/{report_id}/ask")
async def ask_about_report(
    report_id: int,
    body: ReportAskRequest,
    db: Session = Depends(get_db),
):
    """Answer follow-up questions about a specific directed report."""
    r = db.query(DirectedReport).filter(DirectedReport.id == report_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")

    # Build compact report context
    parts: list[str] = [
        f"DIRECTED REPORT — Focus: {r.focus}",
        f"Impact type: {r.impact_type or 'unknown'} | Confidence: {r.confidence_score or '—'}",
    ]
    if r.headline:
        parts.append(f"Headline: {r.headline}")
    if r.executive_summary:
        parts.append(f"Executive Summary:\n{r.executive_summary}")
    if r.key_developments:
        parts.append("Key Developments:\n" + "\n".join(f"• {d}" for d in r.key_developments))
    if r.economic_impact:
        parts.append(f"Economic Impact:\n{r.economic_impact}")
    if r.market_impact:
        parts.append(f"Market Impact:\n{r.market_impact}")
    if r.geopolitical_impact:
        parts.append(f"Geopolitical Impact:\n{r.geopolitical_impact}")
    if r.sector_impact:
        sector_lines = "\n".join(f"  {k}: {v}" for k, v in r.sector_impact.items())
        parts.append(f"Sector Impact:\n{sector_lines}")
    if r.risk_assessment:
        parts.append(f"Risks:\n{r.risk_assessment}")
    if r.opportunities:
        parts.append(f"Opportunities:\n{r.opportunities}")
    if r.contrarian_views:
        parts.append(f"Contrarian Views:\n{r.contrarian_views}")
    if r.prognosis_short:
        parts.append(f"Short-term Prognosis (1-6 mo):\n{r.prognosis_short}")
    if r.prognosis_long:
        parts.append(f"Long-term Prognosis (6-24 mo):\n{r.prognosis_long}")
    if r.signals_to_watch:
        parts.append("Signals to Watch:\n" + "\n".join(f"• {s}" for s in r.signals_to_watch))

    report_context = "\n\n".join(parts)

    system = (
        "You are a senior economic and financial analyst assistant. "
        "The user is asking follow-up questions about the specific research report shown below. "
        "Answer primarily from the report content; when the question goes beyond the report, "
        "draw on your broader knowledge but be explicit that you are doing so. "
        "Be concise and direct — 2–5 sentences unless more detail is clearly needed.\n\n"
        f"=== REPORT ===\n{report_context}"
    )

    history_lines = [f"{m.role.capitalize()}: {m.content}" for m in body.history[-12:]]
    user_prompt = body.question
    if history_lines:
        user_prompt = "Conversation so far:\n" + "\n".join(history_lines) + f"\n\nQuestion: {body.question}"

    try:
        response_text = await call_ai(system=system, user=user_prompt, max_tokens=1200, db=db)
    except Exception as exc:
        logger.error("Report ask failed for report %s: %s", report_id, exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    return {"response": response_text}


@router.post("/summary")
async def generate_summary(
    body: SummaryRequest,
    db: Session = Depends(get_db),
):
    """AI summary of articles — either an explicit selection (article_ids) or a
    tag / category / keyword filter over a time window."""
    fv = body.filter_value.strip()
    selection_mode = bool(body.article_ids)

    if selection_mode:
        # ── Summarize an explicit set of selected articles ───────────────────
        ids = body.article_ids or []
        rows = db.query(Article).filter(Article.id.in_(ids)).all()
        # Preserve the caller's selection order
        by_id = {a.id: a for a in rows}
        articles = [by_id[i] for i in ids if i in by_id]
        if not articles:
            raise HTTPException(status_code=404, detail="None of the selected articles were found")
    else:
        if body.filter_type not in ("tag", "category", "keyword"):
            raise HTTPException(status_code=400, detail="filter_type must be tag, category, or keyword")

        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=body.time_window_hours)
        query = db.query(Article).filter(
            or_(
                and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
                and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
            )
        )

        # ── Explicit filter (tag / category / keyword) ───────────────────────────
        if fv:
            if body.filter_type == "tag":
                query = query.filter(
                    sa_text(
                        "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) = lower(:tv))"
                    ).bindparams(tv=fv)
                )
            elif body.filter_type == "category":
                query = query.filter(Article.category == fv)
            else:  # keyword
                pat = f"%{fv}%"
                query = query.filter(or_(
                    Article.title.ilike(pat),
                    Article.content.ilike(pat),
                    Article.summary.ilike(pat),
                    # Match tags too, so keyword summaries are consistent with the
                    # News page filter (which also matches by tag).
                    sa_text(
                        "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) LIKE lower(:qtag))"
                    ).bindparams(qtag=pat),
                ))

        limit_val = body.max_articles if body.max_articles > 0 else 5000
        articles = (
            query
            .order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
            .limit(limit_val)
            .all()
        )

        if not articles:
            detail = (
                f"No articles found for {body.filter_type}='{fv}' in the last {body.time_window_hours}h"
                if fv else
                f"No articles found in the last {body.time_window_hours}h"
            )
            raise HTTPException(status_code=404, detail=detail)

    # Build per-article context blocks (capped at 500 chars each)
    context_lines: list[str] = []
    for i, a in enumerate(articles, 1):
        published = a.published_at.isoformat() if a.published_at else "unknown"
        excerpt = (a.summary or a.content or "")[:500]
        context_lines.append(
            f"[{i}] {a.title or '(no title)'}\n"
            f"    Source: {a.source or 'unknown'} | Published: {published}\n"
            f"    {excerpt}"
        )
    context_block = "\n\n".join(context_lines)

    # ── System prompt ─────────────────────────────────────────────────────────
    # Base: DB override → built-in default
    _sp_row = db.query(AppSettings).filter(AppSettings.key == "summary_system_prompt").first()
    _custom_sp = (_sp_row.value or "").strip() if _sp_row else ""
    system = _custom_sp if _custom_sp else DEFAULT_SUMMARY_SYSTEM_PROMPT

    # Extra instructions (format / tone / focus) appended verbatim
    if body.custom_prompt and body.custom_prompt.strip():
        system += "\n\nAdditional instructions for this run:\n" + body.custom_prompt.strip()

    # Language override — ALWAYS pin the output language so the AI doesn't mirror
    # the (possibly foreign) source articles. Default / "English" → force English.
    _LANG_INSTRUCTIONS: dict[str, str] = {
        "Hebrew":   "Respond entirely in Hebrew (עברית).",
        "Russian":  "Respond entirely in Russian (Русский).",
        "Georgian": "Respond entirely in Georgian (ქართული).",
        "French":   "Respond entirely in French (Français).",
        "German":   "Respond entirely in German (Deutsch).",
        "Arabic":   "Respond entirely in Arabic (العربية).",
        "Spanish":  "Respond entirely in Spanish (Español).",
    }
    lang = (body.language or "").strip()
    if lang and lang not in ("English", "english"):
        lang_instruction = _LANG_INSTRUCTIONS.get(lang, f"Respond entirely in {lang}.")
    else:
        lang_instruction = (
            "Respond entirely in English, even when the source articles are in "
            "another language."
        )
    system += f"\n\n{lang_instruction}"

    # Header tells the AI what it's looking at
    if selection_mode:
        header = f"Summarize the following {len(articles)} selected articles."
    elif fv:
        header = f"Summarize the following {len(articles)} articles about {body.filter_type} \"{fv}\"."
    else:
        header = f"Summarize the following {len(articles)} recent articles."

    user = f"{header}\n\n{context_block}"

    try:
        raw = await call_ai(system=system, user=user, max_tokens=2000, db=db)
    except Exception as exc:
        logger.error("Summary AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    # Parse JSON response
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    s_idx = cleaned.find("{"); e_idx = cleaned.rfind("}")
    if s_idx != -1 and e_idx != -1:
        cleaned = cleaned[s_idx:e_idx + 1]
    try:
        data = json.loads(cleaned)
    except Exception:
        data = {"summary": raw, "key_themes": [], "notable_sources": [], "time_span": ""}

    sources = [
        {
            "title": a.title,
            "url": a.url,
            "source": a.source,
            "published_at": a.published_at.isoformat() if a.published_at else None,
        }
        for a in articles[:30]
    ]

    return {
        "summary": data.get("summary", ""),
        "key_themes": data.get("key_themes", []),
        "notable_sources": data.get("notable_sources", []),
        "time_span": data.get("time_span", ""),
        "article_count": len(articles),
        "sources": sources,
        "filter_type": "selection" if selection_mode else (body.filter_type if fv else "all"),
        "filter_value": f"{len(articles)} selected articles" if selection_mode else (fv or "all recent articles"),
    }


@router.post("/summary/ask")
async def ask_about_summary(
    body: SummaryAskRequest,
    db: Session = Depends(get_db),
):
    """Answer follow-up questions about a generated summary."""
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="question is required")

    context = (body.summary or "")[:10000]  # cap context window usage
    system = (
        "You are a knowledgeable analyst assistant. "
        "The user generated a summary of recent news/messages and is asking follow-up questions about it. "
        "Answer based strictly on the summary content below; draw on broader knowledge only when the "
        "summary is insufficient, and be explicit that you are doing so. "
        "Be concise: 2–5 sentences unless more detail is clearly needed.\n\n"
        f"=== SUMMARY ===\n{context}"
    )

    history_lines = [
        f"{m['role'].capitalize()}: {m['content']}"
        for m in (body.history or [])[-12:]
        if isinstance(m, dict) and m.get("role") and m.get("content")
    ]
    user_prompt = body.question.strip()
    if history_lines:
        user_prompt = "Conversation history:\n" + "\n".join(history_lines) + f"\n\nQuestion: {user_prompt}"

    try:
        response_text = await call_ai(system=system, user=user_prompt, max_tokens=1200, db=db)
    except Exception as exc:
        logger.error("Summary ask AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    return {"response": response_text}


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
    time_window_hours: int = Query(24, ge=0, le=24 * 365 * 10),  # 0 = all time
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Cheap count of DB articles matching focus + window — for the UI preview."""
    return {"db_article_count": count_db_articles(
        focus.strip(), db, time_window_hours,
        category=category or None,
        tag=tag or None,
    )}


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
            category=body.category or None,
            tag=body.tag or None,
            include_web=body.include_web,
            include_web_search=body.include_web_search,
            time_window_hours=body.time_window_hours,
            max_web_results=body.max_web_results,
            fetch_web_content=body.fetch_web_content,
            language=body.language or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Directed report generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Report generation failed: {exc}")

    # Reports are not kept as history — discard all but the one just generated.
    # (The current report stays so its follow-up chat can resolve it by id.)
    try:
        db.query(DirectedReport).filter(DirectedReport.id != report.id).delete(synchronize_session=False)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("[directed] could not prune old reports: %s", exc)

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


def _build_factcheck_web_block(web_results: list[dict]) -> tuple[str, list[dict]]:
    """Format explicit web search results into a context block + reference list."""
    if not web_results:
        return "", []
    refs: list[dict] = []
    blocks = ["=== LIVE WEB SEARCH RESULTS ==="]
    for i, r in enumerate(web_results, 1):
        blocks.append(
            f"[WEB-{i}] {r.get('title') or '(no title)'}\n"
            f"    Source: {r.get('source') or 'web'} | Published: {r.get('published_at') or 'unknown'}\n"
            f"    URL: {r.get('url')}\n"
            f"    Snippet: {r.get('snippet') or ''}"
        )
        refs.append({
            "kind": "web",
            "title": r.get("title"),
            "url": r.get("url"),
            "source": r.get("source"),
            "snippet": r.get("snippet"),
        })
    return "\n".join(blocks), refs


@router.post("/article/{article_id}/factcheck")
async def factcheck_article(
    article_id: int,
    db: Session = Depends(get_db),
):
    """Fact-check an article's main claims against live web sources.

    Combines an explicit multi-engine web search with the AI provider's native
    web grounding, then returns a structured markdown verdict per claim.
    """
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    content = (article.content or article.summary or "")[:6000]

    # Explicit multi-engine web search seeded from the article's headline.
    search_query = (article.title or article.summary or "").strip()[:200]
    web_block, web_refs = "", []
    if search_query:
        try:
            web_results = await multi_engine_search(search_query, db=db, num=8)
            web_block, web_refs = _build_factcheck_web_block(web_results)
            logger.info("[factcheck] explicit web search returned %d result(s)", len(web_results))
        except Exception as exc:
            logger.warning("[factcheck] explicit web search failed: %s", exc)

    system = (
        "You are a rigorous fact-checker. Verify the factual claims made in the ARTICLE below "
        "against independent, reliable sources. Use your built-in web search AND the LIVE WEB "
        "SEARCH RESULTS provided to corroborate or refute each claim.\n\n"
        "ARTICLE\n"
        f"Title: {article.title or '(no title)'}\n"
        f"Source: {article.source or 'unknown'}\n"
        f"Published: {article.published_at or 'unknown'}\n"
        f"URL: {article.url}\n\n"
        f"{content}\n\n"
        f"{web_block}\n\n"
        "INSTRUCTIONS:\n"
        "- Identify the 3-6 most important, checkable factual claims (figures, events, attributions, dates).\n"
        "- For EACH claim, give a verdict on its own line in this exact markdown format:\n"
        "  **<Verdict>** — <the claim in your own words>. <One-sentence justification with the source.>\n"
        "  where <Verdict> is one of: ✅ Supported, ⚠️ Disputed, ❌ False, ❔ Unverified.\n"
        "- Prefer independent sources; note when the only corroboration is the article's own outlet.\n"
        "- Cite supporting sources inline by URL or [WEB-N] tag.\n"
        "- End with a one-line **Overall:** assessment of the article's reliability.\n"
        "- Be concrete and skeptical. Do not invent corroboration that the sources don't provide."
    )
    user_prompt = "Fact-check the article above and report your findings."

    try:
        grounded = await call_ai_grounded(system=system, user=user_prompt, max_tokens=2000, db=db)
    except Exception as exc:
        logger.error("Fact-check AI call failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    text = grounded.text
    if not grounded.provider_used_grounding and not web_refs:
        text = (
            "_(Your current AI provider doesn't support web grounding and no web results were "
            "available, so this check relies on the model's prior knowledge. Switch to Gemini or "
            "Anthropic in Settings, or configure a search API key, for live verification.)_\n\n"
            + text
        )

    # Append a compact source list from AI citations + explicit web results.
    cite_lines: list[str] = []
    seen_urls: set[str] = set()
    for c in (grounded.citations or []):
        if c.url and c.url not in seen_urls:
            seen_urls.add(c.url)
            cite_lines.append(f"- [{c.title or c.url}]({c.url})")
    for r in web_refs:
        url = r.get("url")
        if url and url not in seen_urls:
            seen_urls.add(url)
            cite_lines.append(f"- [{r.get('title') or url}]({url})")
    if cite_lines:
        text += "\n\n**Sources checked:**\n" + "\n".join(cite_lines[:12])

    return {
        "response": text,
        "references": web_refs,
        "used_web": bool(grounded.provider_used_grounding or web_refs),
    }


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
