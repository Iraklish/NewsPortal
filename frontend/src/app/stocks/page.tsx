'use client'

import { useEffect, useRef, useState } from 'react'
import { stocksApi, settingsApi, type StockAnalysis } from '@/lib/api'
import StockCard from '@/components/StockCard'
import { Search, Loader2, TrendingUp, Plus, X } from 'lucide-react'

export default function StocksPage() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<{ ticker: string; name: string }[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [analysis, setAnalysis] = useState<StockAnalysis | null>(null)
  const [recentAnalyses, setRecentAnalyses] = useState<StockAnalysis[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [quickTickers, setQuickTickers] = useState<string[]>([])
  const [newTicker, setNewTicker] = useState('')
  const [editTickers, setEditTickers] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    stocksApi.getAnalyses().then(setRecentAnalyses).catch(() => {})
    settingsApi.getQuickTickers().then(r => setQuickTickers(r.tickers)).catch(() => {})
  }, [])

  async function persistTickers(next: string[]) {
    setQuickTickers(next)
    try {
      const r = await settingsApi.setQuickTickers(next)
      setQuickTickers(r.tickers)
    } catch {
      // reload authoritative list on failure
      settingsApi.getQuickTickers().then(r => setQuickTickers(r.tickers)).catch(() => {})
    }
  }

  function addTicker() {
    const t = newTicker.trim().toUpperCase()
    if (!t || quickTickers.includes(t)) { setNewTicker(''); return }
    persistTickers([...quickTickers, t])
    setNewTicker('')
  }

  function removeTicker(t: string) {
    persistTickers(quickTickers.filter(x => x !== t))
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 1) { setSuggestions([]); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await stocksApi.search(query.trim())
        setSuggestions(res.slice(0, 6))
        setShowSuggestions(true)
      } catch { setSuggestions([]) }
    }, 350)
  }, [query])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function analyze(ticker: string) {
    setLoading(true)
    setError('')
    setShowSuggestions(false)
    try {
      const res = await stocksApi.analyze(ticker.toUpperCase())
      setAnalysis(res)
      const updated = await stocksApi.getAnalyses()
      setRecentAnalyses(updated)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Stock Reviews</h1>
        <p className="text-slate-500 text-sm mt-1">AI-powered market analysis for any ticker</p>
      </div>

      {/* Search */}
      <div className="relative mb-4" ref={wrapperRef}>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && query.trim() && analyze(query.trim())}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Search ticker or company name…"
            className="w-full bg-[#0d1117] border border-[#1e2433] rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            onClick={() => query.trim() && analyze(query.trim())}
            disabled={loading || !query.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm text-white font-medium transition-colors"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : 'Analyze'}
          </button>
        </div>
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-[#0d1117] border border-[#1e2433] rounded-xl shadow-xl z-20">
            {suggestions.map(s => (
              <button
                key={s.ticker}
                onClick={() => { setQuery(s.ticker); analyze(s.ticker) }}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl"
              >
                <span className="font-mono font-bold text-indigo-400 text-sm w-16">{s.ticker}</span>
                <span className="text-slate-300 text-sm">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quick tickers */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {quickTickers.map(t => (
          <div
            key={t}
            className="group flex items-center bg-[#0d1117] border border-[#1e2433] rounded-lg hover:border-indigo-500/50 transition-colors"
          >
            <button
              onClick={() => { setQuery(t); analyze(t) }}
              className="pl-3 pr-2 py-1.5 text-sm font-mono text-slate-400 group-hover:text-white transition-colors"
            >
              {t}
            </button>
            {editTickers && (
              <button
                onClick={() => removeTicker(t)}
                title={`Remove ${t}`}
                className="pr-2 pl-0.5 py-1.5 text-slate-600 hover:text-red-400 transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}

        {editTickers ? (
          <div className="flex items-center bg-[#0d1117] border border-indigo-500/40 rounded-lg">
            <input
              value={newTicker}
              onChange={e => setNewTicker(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addTicker(); if (e.key === 'Escape') setEditTickers(false) }}
              placeholder="Add ticker…"
              autoFocus
              className="w-28 bg-transparent pl-3 pr-1 py-1.5 text-sm font-mono text-white placeholder-slate-600 focus:outline-none uppercase"
            />
            <button
              onClick={addTicker}
              disabled={!newTicker.trim()}
              className="px-2 py-1.5 text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition-colors"
              title="Add"
            >
              <Plus size={14} />
            </button>
          </div>
        ) : null}

        <button
          onClick={() => setEditTickers(v => !v)}
          className="px-2.5 py-1.5 text-xs text-slate-500 hover:text-white border border-dashed border-[#1e2433] hover:border-indigo-500/50 rounded-lg transition-colors"
        >
          {editTickers ? 'Done' : 'Edit'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{error}</div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-6 animate-pulse">
          <div className="h-8 bg-[#1e2433] rounded w-1/3 mb-4" />
          <div className="h-32 bg-[#1e2433] rounded mb-4" />
          <div className="grid grid-cols-3 gap-3">
            {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-[#1e2433] rounded" />)}
          </div>
        </div>
      )}

      {/* Result */}
      {!loading && analysis && <StockCard analysis={analysis} />}

      {/* Recent analyses */}
      {recentAnalyses.length > 0 && !loading && !analysis && (
        <div>
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <TrendingUp size={14} /> Recent Analyses
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {recentAnalyses.map(ra => (
              <button
                key={ra.id}
                onClick={() => setAnalysis(ra)}
                className="text-left bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/40 rounded-xl p-4 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono font-bold text-white">{ra.ticker}</span>
                  {ra.change_pct != null && (
                    <span className={`text-sm font-semibold ${ra.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {ra.change_pct >= 0 ? '+' : ''}{ra.change_pct.toFixed(2)}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 truncate">{ra.company_name || ra.ticker}</p>
                {ra.price != null && (
                  <p className="text-sm text-slate-300 mt-1">${ra.price.toFixed(2)}</p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
