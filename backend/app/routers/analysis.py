import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, or_, text as sa_text
from sqlalchemy.orm import Session

from ..config import (
    DEFAULT_ASK_SYSTEM_PROMPT,
    DEFAULT_CHAT_SYSTEM_PROMPT,
    DEFAULT_IMAGE_ANALYSIS_PROMPT,
    DEFAULT_LINK_ANALYSIS_PROMPT,
    DEFAULT_SUMMARY_SYSTEM_PROMPT,
)
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
from ..services.ai_client import call_ai, call_ai_grounded, call_ai_vision
from ..services.directed_report import count_db_articles, run_directed_report
from ..services.search_service import fetch_url, multi_engine_search


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


# ── Timeline / heatmap ────────────────────────────────────────────────────────

class TimelineRequest(BaseModel):
    filter_type: str = "keyword"          # "tag" | "category" | "keyword"
    filter_value: str = ""
    time_window_hours: int = 24           # 0 = all time (span derived from data)
    max_articles: int = 0                 # 0 = no hard cap (bounded to 20000)
    granularity: str = "auto"             # auto|15min|30min|hour|3hour|6hour|day|week
    country: Optional[str] = None         # adjustable filter: restrict to a country
    topic: Optional[str] = None           # adjustable filter: restrict to a topic
    q: Optional[str] = None               # adjustable free-text filter


# Weighted escalation/tension lexicon, matched against title + summary.
# Whole-word entries require word boundaries; stem entries match as a prefix
# (e.g. "escalat" → escalate/escalation/escalated).
_ESC_EXACT: dict[str, int] = {
    "war": 3, "missile": 3, "rocket": 3, "strike": 3, "attack": 3, "drone": 3,
    "killed": 3, "dead": 3, "raid": 3, "siege": 3, "nuclear": 3, "offensive": 3,
    "assault": 3, "explosion": 3, "bombing": 3, "ballistic": 3, "warhead": 3,
    "incursion": 3, "ambush": 3,
    "conflict": 2, "clash": 2, "tension": 2, "threat": 2, "sanction": 2, "troops": 2,
    "warning": 2, "crisis": 2, "ceasefire": 2, "truce": 2, "blockade": 2, "standoff": 2,
    "wounded": 2, "alert": 2, "gunfire": 2, "hostage": 2, "coup": 2,
    "protest": 1, "unrest": 1, "dispute": 1, "talks": 1, "summit": 1, "embargo": 1,
    "border": 1, "tariff": 1, "cyberattack": 1,
}
_ESC_STEM: dict[str, int] = {
    "invasi": 3, "invade": 3, "airstrik": 3, "air strik": 3, "shell": 3, "bombard": 3,
    "casualt": 3, "massacre": 3, "retaliat": 3, "escalat": 3,
    "militar": 2, "mobiliz": 2, "deploy": 2, "hostil": 2, "provocation": 2, "evacuat": 2,
    "negotiat": 1, "diplomat": 1,
}
_ESC_PATTERN = re.compile(
    r"\b(?:"
    + "|".join(
        [re.escape(t) + r"\b" for t in sorted(_ESC_EXACT, key=len, reverse=True)]
        + [re.escape(t) for t in sorted(_ESC_STEM, key=len, reverse=True)]
    )
    + ")",
    re.IGNORECASE,
)
_ESC_HIGH = 5   # per-article score at/above which an article is a "severe" event


def _weight_for(tok: str) -> tuple[int, str]:
    t = tok.lower()
    if t in _ESC_EXACT:
        return _ESC_EXACT[t], t
    for stem, w in _ESC_STEM.items():
        if t.startswith(stem):
            return w, stem
    return 0, t


def _tension_score(text: str) -> tuple[int, list[str]]:
    """Return (capped weighted tension score, distinct matched terms)."""
    if not text:
        return 0, []
    score = 0
    matched: list[str] = []
    seen: set[str] = set()
    for m in _ESC_PATTERN.finditer(text):
        w, key = _weight_for(m.group(0))
        if not w:
            continue
        score += w
        if key not in seen:
            seen.add(key)
            matched.append(key)
    return min(score, 15), matched


# ── Country & topic detection (heatmap rows) ──────────────────────────────────
# Each entity maps to a list of lowercase match terms (stems allowed). Matched
# against title + summary with a leading word boundary so "russia" is found in
# "russian" but not in "prussia".
_COUNTRY_TERMS: dict[str, list[str]] = {
    "Israel": ["israel", "israeli", "idf", "jerusalem", "tel aviv", "netanyahu", "knesset"],
    "Palestine": ["palestin", "gaza", "hamas", "west bank", "ramallah", "rafah"],
    "Lebanon": ["lebanon", "lebanese", "beirut", "hezbollah", "hizbollah"],
    "Iran": ["iran", "iranian", "tehran", "irgc", "ayatollah", "khamenei"],
    "Syria": ["syria", "syrian", "damascus"],
    "Yemen": ["yemen", "yemeni", "houthi"],
    "Saudi Arabia": ["saudi", "riyadh"],
    "Ukraine": ["ukrain", "kyiv", "kiev", "zelensky", "zelenskyy"],
    "Russia": ["russia", "russian", "moscow", "kremlin", "putin"],
    "United States": ["united states", "u.s.", "america", "american", "washington", "white house", "biden", "trump", "pentagon"],
    "China": ["china", "chinese", "beijing", "xi jinping", "taiwan"],
    "United Kingdom": ["britain", "british", "united kingdom", "u.k.", "london", "downing street"],
    "Germany": ["german", "berlin", "scholz", "bundestag"],
    "France": ["france", "french", "paris", "macron"],
    "Turkey": ["turkey", "turkish", "ankara", "erdogan", "istanbul"],
    "European Union": ["european union", "brussels", "european commission", "eurozone"],
    "Poland": ["poland", "polish", "warsaw"],
    "Georgia": ["georgia", "georgian", "tbilisi"],
    "India": ["india", "indian", "new delhi", "modi"],
    "North Korea": ["north korea", "pyongyang", "kim jong"],
    "Japan": ["japan", "japanese", "tokyo"],
    "Egypt": ["egypt", "egyptian", "cairo"],
    "Italy": ["italy", "italian", "rome", "meloni"],
    "Spain": ["spain", "spanish", "madrid"],
}
_TOPIC_TERMS: dict[str, list[str]] = {
    "Military conflict": ["war", "missile", "rocket", "airstrike", "air strike", "shelling", "offensive",
                          "troops", "military", "combat", "frontline", "invasion", "drone", "bombard", "artillery"],
    "Diplomacy": ["talks", "negotiat", "summit", "ceasefire", "treaty", "diplomat", "accord", "peace deal"],
    "Economy & markets": ["inflation", "gdp", "recession", "stock market", "stocks", "economy", "interest rate",
                          "central bank", "unemployment", "bond yield"],
    "Energy": ["oil", "natural gas", "pipeline", "opec", "energy", "electricity", "power grid", "fuel"],
    "Elections & politics": ["election", "ballot", "parliament", "coalition", "referendum", "prime minister", "presidential"],
    "Sanctions & trade": ["sanction", "tariff", "embargo", "trade deal", "export ban"],
    "Protests & unrest": ["protest", "riot", "unrest", "demonstration", "uprising"],
    "Security & terrorism": ["terror", "militant", "insurgent", "extremis", "hostage", "kidnap"],
    "Technology & cyber": ["cyber", "hack", "semiconductor", "artificial intelligence", "data breach"],
    "Migration": ["migrant", "refugee", "asylum"],
    "Disasters & climate": ["earthquake", "flood", "wildfire", "hurricane", "climate", "drought"],
}


def _build_entity_pattern(term_map: dict[str, list[str]]) -> tuple[re.Pattern, dict[str, str]]:
    lookup: dict[str, str] = {}
    for label, terms in term_map.items():
        for t in terms:
            lookup[t.lower()] = label
    alts = sorted((re.escape(t) for t in lookup), key=len, reverse=True)
    pattern = re.compile(r"\b(?:" + "|".join(alts) + ")", re.IGNORECASE)
    return pattern, lookup


_COUNTRY_PATTERN, _COUNTRY_LOOKUP = _build_entity_pattern(_COUNTRY_TERMS)
_TOPIC_PATTERN, _TOPIC_LOOKUP = _build_entity_pattern(_TOPIC_TERMS)


def _detect_entities(text: str) -> tuple[set[str], set[str]]:
    """Return (countries, topics) mentioned in the text."""
    if not text:
        return set(), set()
    countries = {_COUNTRY_LOOKUP[m.group(0).lower()] for m in _COUNTRY_PATTERN.finditer(text)
                 if m.group(0).lower() in _COUNTRY_LOOKUP}
    topics = {_TOPIC_LOOKUP[m.group(0).lower()] for m in _TOPIC_PATTERN.finditer(text)
              if m.group(0).lower() in _TOPIC_LOOKUP}
    return countries, topics


def _entity_terms(kind: str, label: str) -> list[str]:
    src = _COUNTRY_TERMS if kind == "country" else _TOPIC_TERMS
    return src.get(label, [])


def _apply_adjustable_filters(query, country: str | None, topic: str | None, q: str | None):
    """AND the timeline's adjustable Country / Topic / Free-text filters onto a query."""
    for kind, label in (("country", country), ("topic", topic)):
        if label:
            terms = _entity_terms(kind, label)
            if terms:
                conds = []
                for t in terms:
                    p = f"%{t}%"
                    conds += [Article.title.ilike(p), Article.summary.ilike(p)]
                query = query.filter(or_(*conds))
    if q and q.strip():
        qp = f"%{q.strip()}%"
        query = query.filter(or_(
            Article.title.ilike(qp), Article.summary.ilike(qp), Article.content.ilike(qp),
        ))
    return query


_GRAN_SECONDS: dict[str, int] = {
    "15min": 900, "30min": 1800, "hour": 3600, "3hour": 10800,
    "6hour": 21600, "day": 86400, "week": 604800,
}
_SNAP_STEPS = [900, 1800, 3600, 10800, 21600, 43200, 86400, 604800]
_MAX_BUCKETS = 120
_MAX_COUNTRY_ROWS = 8
_MAX_TOPIC_ROWS = 6


def _resolve_bucket_seconds(granularity: str, span_seconds: float) -> int:
    if granularity in _GRAN_SECONDS:
        return _GRAN_SECONDS[granularity]
    # auto: aim for ~40 buckets, snapped to a sensible step, then bound the count.
    target = max(900.0, span_seconds / 40.0)
    bucket = next((s for s in _SNAP_STEPS if s >= target), _SNAP_STEPS[-1])
    while span_seconds / bucket > _MAX_BUCKETS:
        idx = _SNAP_STEPS.index(bucket)
        if idx >= len(_SNAP_STEPS) - 1:
            break
        bucket = _SNAP_STEPS[idx + 1]
    return bucket


@router.post("/summary/timeline")
def summary_timeline(body: TimelineRequest, db: Session = Depends(get_db)):
    """Bucketed activity timeline + per-category heatmap with a tension/escalation
    signal, computed over the same article set the summary uses."""
    if body.filter_type not in ("tag", "category", "keyword"):
        raise HTTPException(status_code=400, detail="filter_type must be tag, category, or keyword")

    fv = (body.filter_value or "").strip()
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    query = db.query(
        Article.published_at, Article.fetched_at, Article.category,
        Article.title, Article.summary,
    )
    if body.time_window_hours and body.time_window_hours > 0:
        cutoff = now - timedelta(hours=body.time_window_hours)
        query = query.filter(or_(
            and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
            and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
        ))

    if fv:
        if body.filter_type == "tag":
            query = query.filter(sa_text(
                "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) = lower(:tv))"
            ).bindparams(tv=fv))
        elif body.filter_type == "category":
            query = query.filter(Article.category == fv)
        else:
            pat = f"%{fv}%"
            query = query.filter(or_(
                Article.title.ilike(pat),
                Article.summary.ilike(pat),
                Article.content.ilike(pat),
                sa_text(
                    "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) LIKE lower(:qtag))"
                ).bindparams(qtag=pat),
            ))

    # Adjustable graph filters (Country / Topic / Free text).
    query = _apply_adjustable_filters(query, body.country, body.topic, body.q)

    cap = body.max_articles if body.max_articles and body.max_articles > 0 else 20000
    rows = (
        query.order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
        .limit(cap).all()
    )

    # Normalize to (timestamp, text) keeping only rows with a usable time.
    items: list[tuple[datetime, str]] = []
    for pub, fetched, cat, title, summary in rows:
        ts = pub or fetched
        if not ts:
            continue
        items.append((ts, f"{title or ''} {summary or ''}"))

    if not items:
        return {
            "total": 0, "buckets": [], "rows": [], "matrix": [],
            "max_count": 0, "max_tension": 0, "max_cell": 0, "top_terms": [],
            "granularity": body.granularity, "bucket_seconds": 0,
            "start": None, "end": None,
            "all_countries": list(_COUNTRY_TERMS), "all_topics": list(_TOPIC_TERMS),
        }

    times = [t for t, _ in items]
    start = (now - timedelta(hours=body.time_window_hours)) if body.time_window_hours and body.time_window_hours > 0 else min(times)
    end = now
    span = max(1.0, (end - start).total_seconds())
    bucket_seconds = _resolve_bucket_seconds(body.granularity, span)
    n_buckets = max(1, min(_MAX_BUCKETS, int(span // bucket_seconds) + 1))

    def bucket_index(ts: datetime) -> int:
        idx = int((ts - start).total_seconds() // bucket_seconds)
        return max(0, min(n_buckets - 1, idx))

    counts = [0] * n_buckets
    tension = [0] * n_buckets
    escalation = [0] * n_buckets
    term_counter: dict[str, int] = {}
    # Heatmap rows are detected entities — countries and topics, not feed categories.
    ent_totals: dict[tuple[str, str], int] = {}          # (kind, label) -> total mentions
    ent_bucket: dict[tuple[str, str], list[int]] = {}    # (kind, label) -> per-bucket counts

    for ts, text in items:
        bi = bucket_index(ts)
        counts[bi] += 1
        score, matched = _tension_score(text)
        tension[bi] += score
        if score >= _ESC_HIGH:
            escalation[bi] += 1
        for m in matched:
            term_counter[m] = term_counter.get(m, 0) + 1
        countries, topics = _detect_entities(text)
        for kind, labels in (("country", countries), ("topic", topics)):
            for label in labels:
                key = (kind, label)
                ent_totals[key] = ent_totals.get(key, 0) + 1
                ent_bucket.setdefault(key, [0] * n_buckets)[bi] += 1

    # Pick the most-mentioned countries and topics as heatmap rows.
    ranked = sorted(ent_totals, key=lambda k: ent_totals[k], reverse=True)
    top_countries = [k for k in ranked if k[0] == "country"][:_MAX_COUNTRY_ROWS]
    top_topics = [k for k in ranked if k[0] == "topic"][:_MAX_TOPIC_ROWS]
    chosen = top_countries + top_topics
    rows_out = [{"label": label, "kind": kind, "total": ent_totals[(kind, label)]} for (kind, label) in chosen]
    matrix = [ent_bucket[k] for k in chosen]

    buckets = []
    for i in range(n_buckets):
        b_start = start + timedelta(seconds=bucket_seconds * i)
        buckets.append({
            "start": b_start.isoformat(),
            "count": counts[i],
            "tension": tension[i],
            "escalation": escalation[i],
        })

    top_terms = sorted(term_counter.items(), key=lambda kv: kv[1], reverse=True)[:12]

    return {
        "total": len(items),
        "buckets": buckets,
        "rows": rows_out,
        "matrix": matrix,
        "max_count": max(counts) if counts else 0,
        "max_tension": max(tension) if tension else 0,
        "max_cell": max((max(r) for r in matrix), default=0),
        "top_terms": [{"term": t, "count": c} for t, c in top_terms],
        "granularity": body.granularity,
        "bucket_seconds": bucket_seconds,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "all_countries": list(_COUNTRY_TERMS),
        "all_topics": list(_TOPIC_TERMS),
    }


class TimelineArticlesRequest(BaseModel):
    filter_type: str = "keyword"
    filter_value: str = ""
    start: str                       # ISO timestamp (inclusive)
    end: str                         # ISO timestamp (exclusive)
    country: Optional[str] = None    # restrict to a country
    topic: Optional[str] = None      # restrict to a topic
    q: Optional[str] = None          # free-text restriction
    limit: int = 100


@router.post("/summary/timeline/articles")
def summary_timeline_articles(body: TimelineArticlesRequest, db: Session = Depends(get_db)):
    """Drill-down: list the articles behind a timeline bucket / heatmap cell."""
    if body.filter_type not in ("tag", "category", "keyword"):
        raise HTTPException(status_code=400, detail="filter_type must be tag, category, or keyword")
    try:
        start = datetime.fromisoformat(body.start).replace(tzinfo=None)
        end = datetime.fromisoformat(body.end).replace(tzinfo=None)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid start/end timestamp")

    query = db.query(Article).filter(or_(
        and_(Article.published_at.isnot(None), Article.published_at >= start, Article.published_at < end),
        and_(Article.published_at.is_(None), Article.fetched_at >= start, Article.fetched_at < end),
    ))

    # Country / Topic / Free-text restrictions from the graph + clicked cell.
    query = _apply_adjustable_filters(query, body.country, body.topic, body.q)

    fv = (body.filter_value or "").strip()
    if fv:
        if body.filter_type == "tag":
            query = query.filter(sa_text(
                "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) = lower(:tv))"
            ).bindparams(tv=fv))
        elif body.filter_type == "category":
            query = query.filter(Article.category == fv)
        else:
            pat = f"%{fv}%"
            query = query.filter(or_(
                Article.title.ilike(pat),
                Article.summary.ilike(pat),
                Article.content.ilike(pat),
                sa_text(
                    "EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE lower(value) LIKE lower(:qtag))"
                ).bindparams(qtag=pat),
            ))

    limit = max(1, min(500, body.limit))
    rows = (
        query.order_by(Article.published_at.desc().nullslast(), Article.fetched_at.desc())
        .limit(limit).all()
    )

    out = []
    for a in rows:
        score, terms = _tension_score(f"{a.title or ''} {a.summary or ''}")
        ts = a.published_at or a.fetched_at
        out.append({
            "id": a.id,
            "title": a.title,
            "source": a.source,
            "url": a.url,
            "category": a.category,
            "published_at": ts.isoformat() if ts else None,
            "tension": score,
            "terms": terms[:5],
        })
    return {"articles": out, "count": len(out)}


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

    # If the post has an image, make the chat image-aware so questions about the
    # picture ("what's on the image?") can be answered. Falls back to text-only.
    image_bytes, mime = (None, "image/jpeg")
    if (article.image_url or "").strip():
        try:
            image_bytes, mime = await _load_image(article.image_url)
        except Exception:
            image_bytes = None

    try:
        if image_bytes:
            vision_system = system + "\n\nAN IMAGE FROM THE POST IS ATTACHED. Use it to answer questions about the picture."
            try:
                response_text = await call_ai_vision(system=vision_system, user=user_prompt, image_bytes=image_bytes, mime=mime, max_tokens=1200, db=db)
            except Exception as vexc:
                logger.warning("Ask-article vision call failed, falling back to text: %s", vexc)
                response_text = await call_ai(system=system, user=user_prompt, max_tokens=1200, db=db)
        else:
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


_URL_RE = re.compile(r"https?://[^\s)>\]]+")


class AnalyzeAttachmentRequest(BaseModel):
    kind: str            # 'image' | 'link'
    url: Optional[str] = None
    language: str = ""


def _media_path_for(image_url: str):
    """Resolve a stored /media/... URL to its local file path (or None)."""
    if not image_url or not image_url.startswith("/media/"):
        return None
    from pathlib import Path
    media_root = Path(__file__).resolve().parents[2] / "media"
    rel = image_url[len("/media/"):]
    p = (media_root / rel).resolve()
    # Guard against path traversal — must stay under media_root.
    if media_root.resolve() in p.parents and p.exists():
        return p
    return None


async def _load_image(image_url: str) -> tuple[bytes | None, str]:
    """Load image bytes + mime from a local /media path or a remote http(s) URL."""
    import mimetypes
    image_url = (image_url or "").strip()
    if not image_url:
        return None, "image/jpeg"

    # Local stored media file.
    path = _media_path_for(image_url)
    if path:
        mime = mimetypes.guess_type(str(path))[0] or "image/jpeg"
        try:
            return path.read_bytes(), mime
        except Exception:
            return None, mime

    # Remote image (e.g. RSS article image).
    if image_url.startswith(("http://", "https://")):
        import httpx
        headers = {"User-Agent": "Mozilla/5.0 (compatible; NewsPortal/1.0)"}
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                r = await client.get(image_url, headers=headers)
                r.raise_for_status()
                ctype = (r.headers.get("content-type") or "").split(";")[0].strip()
                mime = ctype if ctype.startswith("image/") else (mimetypes.guess_type(image_url)[0] or "image/jpeg")
                data = r.content
                if data and len(data) <= 15 * 1024 * 1024:
                    return data, mime
        except Exception:
            return None, "image/jpeg"
    return None, "image/jpeg"


@router.post("/article/{article_id}/analyze-attachment")
async def analyze_attachment(article_id: int, body: AnalyzeAttachmentRequest, db: Session = Depends(get_db)):
    """Analyze a post's media (image, via vision) or a link found in it."""
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    lang = (body.language or "").strip()
    lang_clause = "" if not lang or lang.lower() == "english" else f" Respond entirely in {lang}."

    if body.kind == "image":
        if not (article.image_url or "").strip():
            raise HTTPException(status_code=400, detail="No image attached to this post")
        image_bytes, mime = await _load_image(article.image_url)
        if not image_bytes:
            raise HTTPException(status_code=502, detail="Could not load the post image")
        system = _get_prompt(db, "image_analysis_prompt", DEFAULT_IMAGE_ANALYSIS_PROMPT) + lang_clause
        ctx = (article.content or article.title or "").strip()[:1500]
        user = f"Post text for context:\n{ctx}\n\nAnalyze the attached image."
        try:
            text = await call_ai_vision(system=system, user=user, image_bytes=image_bytes, mime=mime, db=db)
        except Exception as exc:
            logger.error("Attachment image analysis failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"Image analysis failed: {exc}")
        return {"response": text, "kind": "image"}

    if body.kind == "link":
        url = (body.url or "").strip()
        if not url:
            m = _URL_RE.search(article.content or "")
            url = m.group(0) if m else ""
        if not url:
            raise HTTPException(status_code=400, detail="No link found in this post")
        try:
            page = await fetch_url(url)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Could not fetch link: {exc}")
        if page.get("status") != "ok" or not (page.get("content") or "").strip():
            raise HTTPException(status_code=502, detail=page.get("error") or "Could not read the linked page")
        content = (page.get("content") or "")[:8000]
        system = _get_prompt(db, "link_analysis_prompt", DEFAULT_LINK_ANALYSIS_PROMPT) + lang_clause
        user = (
            f"Source link: {url}\n"
            f"Title: {page.get('title') or '(unknown)'}\n\n"
            f"Linked article content:\n{content}"
        )
        try:
            text = await call_ai(system=system, user=user, max_tokens=1500, db=db)
        except Exception as exc:
            logger.error("Attachment link analysis failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"Link analysis failed: {exc}")
        return {"response": text, "kind": "link", "url": url}

    raise HTTPException(status_code=400, detail="kind must be 'image' or 'link'")


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
