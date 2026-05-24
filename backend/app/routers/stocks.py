import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import StockAnalysis
from ..schemas import StockAnalysisOut
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
    db: Session = Depends(get_db),
):
    """List all stored stock analyses."""
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
