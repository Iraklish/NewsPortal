"""Synthesize a rich, multi-source directed report.

Sources:
  1. Recent DB articles matching focus keywords (always)
  2. AI-native grounding (Gemini/Anthropic built-in web search) when include_web=True
Then asks the AI to produce a single structured synthesis with citations.
"""
import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from ..models import AppSettings, Article, DirectedReport
from .ai_client import call_ai, call_ai_grounded, get_current_ai_settings

logger = logging.getLogger(__name__)

_IMPACT_LEVELS = {"highly_positive", "positive", "neutral", "negative", "highly_negative"}


# ── Context gathering ────────────────────────────────────────────────────────

def _gather_db_articles(
    focus: str,
    db: Session,
    hours: int,
    hard_cap: int = 1000,
    category: str | None = None,
    tag: str | None = None,
) -> list[Article]:
    """Match articles by any focus keyword within the last `hours`, sorted by recency.

    ``hours=0`` means **all time** — no date filter is applied.
    `hard_cap` is a safety ceiling (default 1 000); the context block uses adaptive
    per-article excerpt lengths to stay within model context limits.
    When `category` is provided only articles in that category are returned.
    When `tag` is provided only articles carrying that tag are returned.
    """
    keywords = [kw.strip() for kw in focus.split() if len(kw.strip()) > 2]
    query = db.query(Article)
    # Time window: prefer published_at when present, fall back to fetched_at.
    # hours=0 → skip the filter entirely (all-time).
    if hours > 0:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
        query = query.filter(
            or_(
                and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
                and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
            )
        )
    if category:
        query = query.filter(Article.category == category)
    if tag:
        query = query.filter(
            text("EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE value = :tv)").bindparams(tv=tag)
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


def count_db_articles(
    focus: str,
    db: Session,
    hours: int,
    category: str | None = None,
    tag: str | None = None,
) -> int:
    """Lightweight count of DB articles matching focus in window (no row fetch).

    When `category` is provided only articles in that category are counted.
    When `tag` is provided only articles carrying that tag are counted.
    """
    keywords = [kw.strip() for kw in focus.split() if len(kw.strip()) > 2]
    query = db.query(Article.id)
    if hours > 0:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
        query = query.filter(
            or_(
                and_(Article.published_at.isnot(None), Article.published_at >= cutoff),
                and_(Article.published_at.is_(None), Article.fetched_at >= cutoff),
            )
        )
    if category:
        query = query.filter(Article.category == category)
    if tag:
        query = query.filter(
            text("EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE value = :tv)").bindparams(tv=tag)
        )
    if keywords:
        conditions = []
        for kw in keywords:
            conditions.append(Article.title.ilike(f"%{kw}%"))
            conditions.append(Article.content.ilike(f"%{kw}%"))
            conditions.append(Article.summary.ilike(f"%{kw}%"))
        query = query.filter(or_(*conditions))
    return query.count()


# ── Context assembly (LangChain-style map-reduce chain) ──────────────────────
#
# The corpus can be up to 1 000 articles.  Cramming them all into one prompt
# forces tiny per-article excerpts (≈150 chars) and loses almost all content.
# Instead we run a map-reduce *chain* (the LCEL summarization pattern):
#
#   MAP    fan out the articles into batches and condense each batch — in
#          parallel — into a tight, focus-relevant evidence digest that keeps
#          [DB-N] citation tags.  Each map call sees the *full* article text.
#   REDUCE the synthesis prompt (run_directed_report) consumes the digests
#          instead of raw truncated articles.
#
# For small corpora the map step is pure overhead, so we fall back to inline
# excerpts below _MAP_REDUCE_THRESHOLD.

_MAP_REDUCE_THRESHOLD = 40   # ≤ this many articles → single-pass inline excerpts
_MAP_BATCH_SIZE = 20         # articles condensed per map call
_MAP_MAX_CONCURRENCY = 5     # simultaneous map calls (rate-limit guard)
_MAP_EXCERPT_LEN = 2000      # per-article content fed into a map call


def _db_references(db_articles: list[Article]) -> list[dict]:
    """Build the citation reference list for DB articles (independent of context size)."""
    refs: list[dict] = []
    for a in db_articles:
        published = a.published_at.isoformat() if a.published_at else "unknown"
        snippet = a.summary or (a.content or "")[:200] or None
        refs.append({
            "kind": "db",
            "title": a.title,
            "url": a.url,
            "source": a.source,
            "published_at": published,
            "snippet": snippet,
        })
    return refs


def _inline_db_block(db_articles: list[Article]) -> str:
    """Small-corpus path: list articles inline with adaptive excerpt length."""
    n = len(db_articles)
    if n <= 100:
        excerpt_len = 1200
    elif n <= 300:
        excerpt_len = 600
    elif n <= 600:
        excerpt_len = 300
    else:
        excerpt_len = 150

    blocks = [f"=== EXISTING NEWS (from local database — {n} articles) ==="]
    for i, a in enumerate(db_articles, 1):
        published = a.published_at.isoformat() if a.published_at else "unknown"
        excerpt = (a.content or a.summary or "")[:excerpt_len]
        blocks.append(
            f"[DB-{i}] {a.title or '(no title)'}\n"
            f"    Source: {a.source or 'unknown'} | Published: {published}\n"
            f"    URL: {a.url}\n"
            + (f"    Excerpt: {excerpt}\n" if excerpt else "")
        )
    return "\n".join(blocks)


def _format_batch_for_map(batch: list[Article], start_idx: int) -> str:
    lines = []
    for offset, a in enumerate(batch):
        idx = start_idx + offset
        published = a.published_at.isoformat() if a.published_at else "unknown"
        excerpt = (a.content or a.summary or "")[:_MAP_EXCERPT_LEN]
        lines.append(
            f"[DB-{idx}] {a.title or '(no title)'} | {a.source or 'unknown'} | {published}\n"
            f"{excerpt}"
        )
    return "\n\n".join(lines)


async def _map_condense_batch(focus: str, batch: list[Article], start_idx: int,
                              sem: asyncio.Semaphore, db: Session) -> str:
    """MAP step: condense one batch of articles into a focus-relevant digest."""
    system = (
        "You are a financial-news analyst building evidence for a larger report. "
        "From the articles below, extract ONLY facts, figures, named entities, "
        "dates and developments that are relevant to the focus topic. Preserve the "
        "[DB-N] citation tag on every bullet. Be terse and factual; drop anything "
        "irrelevant to the focus. Output plain-text bullet points, one fact per line."
    )
    user = (
        f'Focus topic: "{focus}"\n\n'
        f"Articles:\n\n{_format_batch_for_map(batch, start_idx)}\n\n"
        "Return a tight bulleted digest of focus-relevant facts. "
        "Each line MUST end with its [DB-N] citation."
    )
    async with sem:
        try:
            return await call_ai(system=system, user=user, max_tokens=1200, db=db)
        except Exception as exc:
            logger.warning("[report] map step failed for batch @%d: %s", start_idx, exc)
            # Degrade gracefully: keep the batch as short raw excerpts so it isn't lost.
            return _format_batch_for_map(batch, start_idx)[:1500]


async def _map_reduce_db_block(focus: str, db_articles: list[Article], db: Session) -> str:
    """Large-corpus path: fan out condensation across batches, then stitch digests."""
    batches: list[tuple[int, list[Article]]] = []
    idx = 1
    for i in range(0, len(db_articles), _MAP_BATCH_SIZE):
        batch = db_articles[i:i + _MAP_BATCH_SIZE]
        batches.append((idx, batch))
        idx += len(batch)

    logger.info(
        "[report] map-reduce: condensing %d articles in %d batch(es), concurrency=%d",
        len(db_articles), len(batches), _MAP_MAX_CONCURRENCY,
    )
    sem = asyncio.Semaphore(_MAP_MAX_CONCURRENCY)
    digests = await asyncio.gather(
        *(_map_condense_batch(focus, batch, start, sem, db) for start, batch in batches)
    )

    blocks = [
        f"=== CONDENSED EVIDENCE DIGEST (map-reduced from {len(db_articles)} local "
        "articles; [DB-N] tags reference the original sources) ==="
    ]
    for i, digest in enumerate(digests, 1):
        blocks.append(f"--- digest {i} ---\n{(digest or '').strip()}")
    return "\n\n".join(blocks)


def _web_block(web_results: list[dict]) -> tuple[str, list[dict]]:
    """Format live web results into a context block + their references."""
    if not web_results:
        return "", []
    refs: list[dict] = []
    blocks = ["=== LIVE WEB SEARCH RESULTS ==="]
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


async def _build_db_context(focus: str, db_articles: list[Article], db: Session) -> tuple[str, list[dict]]:
    """Return (db_context_text, db_references).

    Runs the map-reduce chain when the corpus is large, otherwise lists articles
    inline.  The DB references are always built from the full article set so the
    report cites every source regardless of how the context was assembled.
    """
    refs = _db_references(db_articles)
    if not db_articles:
        return "", refs
    if len(db_articles) <= _MAP_REDUCE_THRESHOLD:
        return _inline_db_block(db_articles), refs
    text = await _map_reduce_db_block(focus, db_articles, db)
    return text, refs


def _assemble_context(db_context: str, db_refs: list[dict],
                      web_results: list[dict]) -> tuple[str, list[dict]]:
    """REDUCE input: combine the (cached) DB context with web results."""
    web_text, web_refs = _web_block(web_results)
    parts = [p for p in (db_context, web_text) if p]
    return "\n\n".join(parts), db_refs + web_refs


_LANG_INSTRUCTIONS: dict[str, str] = {
    "Hebrew":   "Respond entirely in Hebrew (עברית).",
    "Russian":  "Respond entirely in Russian (Русский).",
    "Georgian": "Respond entirely in Georgian (ქართული).",
    "French":   "Respond entirely in French (Français).",
    "German":   "Respond entirely in German (Deutsch).",
    "Arabic":   "Respond entirely in Arabic (العربية).",
    "Spanish":  "Respond entirely in Spanish (Español).",
}


def _build_prompts(focus: str, context_text: str, system_prompt: str | None = None, language: str = "") -> tuple[str, str]:
    from ..config import DEFAULT_DIRECTED_REPORT_SYSTEM_PROMPT
    system = (system_prompt or "").strip() or DEFAULT_DIRECTED_REPORT_SYSTEM_PROMPT
    lang = (language or "").strip()
    if lang and lang not in ("English", "english"):
        lang_instruction = _LANG_INSTRUCTIONS.get(lang, f"Respond entirely in {lang}.")
    else:
        # Default / English → pin English so the model doesn't mirror foreign-language sources.
        lang_instruction = (
            "Respond entirely in English, even when the source articles are in another language."
        )
    system += f"\n\n{lang_instruction}"

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


# ── Type coercers — guard against AI returning wrong types ──────────────────
# The AI prompt asks for specific types but LLMs occasionally return a list
# where we expect a plain string, or vice-versa.  These helpers normalise the
# value before it hits SQLAlchemy so we never get a "type 'list' is not
# supported" binding error.

def _coerce_text(val, default: str = "") -> str:
    """Convert anything to a plain string (TEXT column)."""
    if val is None:
        return default
    if isinstance(val, str):
        return val
    if isinstance(val, list):
        # Join list items as readable bullet points
        return "\n".join(
            f"• {item}" if not str(item).startswith(("•", "-", "*", "1", "2", "3", "4", "5")) else str(item)
            for item in val
        )
    if isinstance(val, dict):
        return json.dumps(val, ensure_ascii=False)
    return str(val)


def _coerce_list(val, default: list | None = None) -> list:
    """Convert anything to a list (JSON column)."""
    if val is None:
        return default if default is not None else []
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
        return [val]
    return [str(val)]


def _coerce_dict(val, default: dict | None = None) -> dict:
    """Convert anything to a dict (JSON column)."""
    if val is None:
        return default if default is not None else {}
    if isinstance(val, dict):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {}


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
    category: str | None = None,        # if set, restrict DB articles to this category
    tag: str | None = None,             # if set, restrict DB articles to those carrying this tag
    include_web: bool = True,
    include_web_search: bool = False,   # explicit multi-engine search (Google/DDG/Bing)
    time_window_hours: int = 24,
    max_web_results: int = 6,           # kept for API back-compat; ignored under grounding
    fetch_web_content: bool = False,    # kept for API back-compat; ignored under grounding
    language: str = "",                 # "" / "English" → no change; other values → respond in that language
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

    # Read optional custom system prompt from DB
    _dr_prompt_row = db.query(AppSettings).filter(AppSettings.key == "directed_report_system_prompt").first()
    _custom_system_prompt = (_dr_prompt_row.value or "").strip() if _dr_prompt_row else ""

    db_articles = _gather_db_articles(focus, db, time_window_hours, category=category, tag=tag)
    logger.info(
        "[report] gathered %d DB article(s) (window=%sh, category=%s, tag=%s)",
        len(db_articles), time_window_hours or "∞", category or "all", tag or "none",
    )
    if not db_articles and not include_web and not include_web_search:
        raise ValueError("No DB articles match this focus in the chosen window; enable web grounding or web search, or widen the window")

    # ── Step 0: explicit web search (always runs when requested) ─────────────
    explicit_web_results: list[dict] = []
    if include_web_search:
        from .search_service import multi_engine_search
        logger.info("[report] running explicit web search for '%s'", focus[:80])
        explicit_web_results = await multi_engine_search(focus, db=db, num=8)
        logger.info("[report] explicit web search: %d result(s)", len(explicit_web_results))

    # ── Chain stage 1 (MAP): condense the DB corpus once. For large corpora this
    # fans out parallel batch-condensation calls; the result is cached and reused
    # even if we have to re-assemble context for the search fallback below.
    db_context, db_refs = await _build_db_context(focus, db_articles, db)

    # Build initial context (condensed DB articles + any explicit web results)
    context_text, references = _assemble_context(db_context, db_refs, explicit_web_results)
    system, user = _build_prompts(focus, context_text, _custom_system_prompt, language)

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
                # Reuse the cached DB digest and just re-attach the new web blocks
                # so the AI sees web snippets as [WEB-N] blocks it can cite.
                context_text, references = _assemble_context(db_context, db_refs, fallback_results)
                system, user = _build_prompts(focus, context_text, _custom_system_prompt, language)
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
        # Text columns — coerce in case the AI returned a list or dict
        headline=_coerce_text(data.get("headline")),
        executive_summary=_coerce_text(data.get("executive_summary")),
        economic_impact=_coerce_text(data.get("economic_impact")),
        market_impact=_coerce_text(data.get("market_impact")),
        geopolitical_impact=_coerce_text(data.get("geopolitical_impact")),
        risk_assessment=_coerce_text(data.get("risk_assessment")),
        opportunities=_coerce_text(data.get("opportunities")),
        contrarian_views=_coerce_text(data.get("contrarian_views")),
        prognosis_short=_coerce_text(data.get("prognosis_short")),
        prognosis_long=_coerce_text(data.get("prognosis_long")),
        # JSON list columns — coerce in case the AI returned a plain string
        key_developments=_coerce_list(data.get("key_developments")),
        signals_to_watch=_coerce_list(data.get("signals_to_watch")),
        # JSON dict column — coerce in case the AI returned a JSON-encoded string
        sector_impact=_coerce_dict(data.get("sector_impact")),
        # Scalars
        confidence_score=float(data.get("confidence_score") or 0.0),
        impact_type=impact_type,
        references=references,
        db_article_count=len(db_articles),
        web_result_count=sum(1 for r in references if r.get("kind") == "web"),
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
