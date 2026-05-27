import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, StockAnalysis
from ..schemas import StockAnalysisOut, StockAskRequest
from ..services.stock_service import analyze_stock, get_history, get_quote, search_ticker

router = APIRouter()
logger = logging.getLogger(__name__)


# IMPORTANT: fixed-path routes MUST come before variable-path routes

@router.get("/search")
async def search_tickers(q: str = Query(..., min_length=1)):
    """Search for stock tickers matching the query."""
    results = await search_ticker(q)
    return results


@router.get("/analyses", response_model=list[StockAnalysisOut])
def list_stock_analyses(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    unique: bool = Query(True, description="Return only the latest analysis per ticker"),
    db: Session = Depends(get_db),
):
    """List stored stock analyses. By default returns the latest analysis per ticker."""
    if unique:
        subq = (
            db.query(func.max(StockAnalysis.id).label("max_id"))
            .group_by(StockAnalysis.ticker)
            .subquery()
        )
        return (
            db.query(StockAnalysis)
            .join(subq, StockAnalysis.id == subq.c.max_id)
            .order_by(StockAnalysis.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
    return (
        db.query(StockAnalysis)
        .order_by(StockAnalysis.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.get("/{ticker}/quote")
async def stock_quote(ticker: str):
    """Get current quote for a ticker."""
    try:
        quote = await get_quote(ticker.upper())
    except Exception as exc:
        logger.error("Failed to get quote for %s: %s", ticker, exc)
        raise HTTPException(status_code=500, detail=f"Failed to fetch quote: {exc}")
    return quote


@router.get("/{ticker}/history")
async def stock_history(
    ticker: str,
    period: str = Query("1mo", description="e.g. 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y"),
):
    """Get price history for a ticker."""
    try:
        history = await get_history(ticker.upper(), period)
    except Exception as exc:
        logger.error("Failed to get history for %s: %s", ticker, exc)
        raise HTTPException(status_code=500, detail=f"Failed to fetch history: {exc}")
    return history


@router.post("/{ticker}/analyze", response_model=StockAnalysisOut)
async def analyze_stock_endpoint(ticker: str, db: Session = Depends(get_db)):
    """Run full AI analysis for a ticker and store the result."""
    try:
        result = await analyze_stock(ticker.upper(), db)
    except Exception as exc:
        logger.error("Stock analysis failed for %s: %s", ticker, exc)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}")

    analysis = db.query(StockAnalysis).filter(StockAnalysis.id == result["id"]).first()
    return analysis


@router.get("/{ticker}/latest", response_model=StockAnalysisOut)
def get_latest_stock_analysis(ticker: str, db: Session = Depends(get_db)):
    """Get the most recent stored analysis for a ticker."""
    record = (
        db.query(StockAnalysis)
        .filter(StockAnalysis.ticker == ticker.upper())
        .order_by(StockAnalysis.created_at.desc())
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail=f"No analysis found for {ticker}")
    return record


@router.post("/{ticker}/ask")
async def ask_about_stock(
    ticker: str,
    body: StockAskRequest,
    db: Session = Depends(get_db),
):
    """Answer follow-up questions about a stock using the latest stored analysis as context."""
    from ..services.ai_client import call_ai

    ticker = ticker.upper()
    analysis = (
        db.query(StockAnalysis)
        .filter(StockAnalysis.ticker == ticker)
        .order_by(StockAnalysis.created_at.desc())
        .first()
    )
    if not analysis:
        raise HTTPException(status_code=404, detail=f"No analysis found for {ticker}")

    # Build compact analysis context
    parts: list[str] = [
        f"STOCK ANALYSIS — {ticker} ({analysis.company_name or ticker})",
        f"Price: ${analysis.price:.2f}" + (f" ({analysis.change_pct:+.2f}%)" if analysis.change_pct is not None else ""),
        f"Market Cap: {analysis.market_cap}" if analysis.market_cap else "",
        f"Sector: {analysis.sector}" if analysis.sector else "",
        f"Impact: {analysis.impact_type or '—'} | Risk: {analysis.risk_level or '—'} | Confidence: {round((analysis.confidence_score or 0) * 100)}%",
    ]
    if analysis.summary:
        parts.append(f"Summary:\n{analysis.summary}")
    if analysis.technical_summary:
        parts.append(f"Technical Analysis:\n{analysis.technical_summary}")
    if analysis.news_impact:
        parts.append(f"News Impact:\n{analysis.news_impact}")
    if analysis.catalysts:
        parts.append("Catalysts:\n" + "\n".join(f"• {c}" for c in analysis.catalysts))
    if analysis.key_levels:
        levels = " | ".join(f"{k}: ${v}" for k, v in analysis.key_levels.items())
        parts.append(f"Key Levels: {levels}")
    if analysis.prognosis_short:
        parts.append(f"Short-term Prognosis:\n{analysis.prognosis_short}")
    if analysis.prognosis_long:
        parts.append(f"Long-term Prognosis:\n{analysis.prognosis_long}")

    context = "\n\n".join(p for p in parts if p)

    system = (
        "You are a senior equity analyst and trader. "
        "The user is asking follow-up questions about the stock analysis shown below. "
        "Answer primarily from the analysis content; when the question goes beyond it, "
        "draw on your broader market knowledge and say so explicitly. "
        "Be concise — 2–5 sentences unless more detail is clearly needed. "
        "Never give financial advice or buy/sell recommendations.\n\n"
        f"=== ANALYSIS ===\n{context}"
    )

    history_lines = [f"{m.role.capitalize()}: {m.content}" for m in body.history[-12:]]
    user_prompt = body.question
    if history_lines:
        user_prompt = "Conversation so far:\n" + "\n".join(history_lines) + f"\n\nQuestion: {body.question}"

    try:
        response_text = await call_ai(system=system, user=user_prompt, max_tokens=1200, db=db)
    except Exception as exc:
        logger.error("Stock ask failed for %s: %s", ticker, exc)
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    return {"response": response_text}
