'use client'

import { useState, useRef, useEffect } from 'react'
import { searchApi, articlesApi, type WebSearchResult } from '@/lib/api'
import { Search, Loader2, ExternalLink, Download, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react'
import clsx from 'clsx'

const ENGINE_COLORS: Record<string, string> = {
  duckduckgo: 'bg-orange-500/10 text-orange-400 border-orange-500/25',
  bing:       'bg-sky-500/10   text-sky-400   border-sky-500/25',
  google:     'bg-blue-500/10  text-blue-400  border-blue-500/25',
  google_cse: 'bg-blue-500/10  text-blue-400  border-blue-500/25',
  yahoo:      'bg-purple-500/10 text-purple-400 border-purple-500/25',
  startpage:  'bg-teal-500/10  text-teal-400  border-teal-500/25',
}

const ENGINE_LABELS: Record<string, string> = {
  duckduckgo: 'DDG',
  bing:       'Bing',
  google:     'Google',
  google_cse: 'Google',
  yahoo:      'Yahoo',
  startpage:  'Startpage',
}

type EngineKey = 'duckduckgo' | 'bing' | 'google' | 'yahoo' | 'startpage'
type Filter = 'all' | EngineKey

type Engines = { duckduckgo: number; bing: number; google: number; yahoo: number; startpage: number }

const FILTER_TABS: Array<{ key: Filter; label: string }> = [
  { key: 'all',        label: 'All' },
  { key: 'duckduckgo', label: 'DDG' },
  { key: 'bing',       label: 'Bing' },
  { key: 'yahoo',      label: 'Yahoo' },
  { key: 'startpage',  label: 'Startpage' },
  { key: 'google',     label: 'Google' },
]

export default function SearchPage() {
  const [query, setQuery]         = useState('')
  const [num, setNum]             = useState(100)
  const [loading, setLoading]     = useState(false)
  const [results, setResults]     = useState<WebSearchResult[]>([])
  const [engines, setEngines]     = useState<Engines | null>(null)
  const [error, setError]         = useState('')
  const [filter, setFilter]       = useState<Filter>('all')
  const [importing, setImporting] = useState<Record<string, 'idle' | 'loading' | 'done' | 'error'>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setError('')
    setResults([])
    setEngines(null)
    setFilter('all')
    setImporting({})
    try {
      const data = await searchApi.search(q, num)
      if (data.error) setError(data.error)
      setResults(data.results)
      setEngines(data.engines as Engines)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function importResult(r: WebSearchResult) {
    const key = r.url
    setImporting(prev => ({ ...prev, [key]: 'loading' }))
    try {
      await articlesApi.importUrls([r.url], 'web_search')
      setImporting(prev => ({ ...prev, [key]: 'done' }))
    } catch {
      setImporting(prev => ({ ...prev, [key]: 'error' }))
    }
  }

  const filtered = filter === 'all'
    ? results
    : results.filter(r => (r.engine === 'google_cse' ? 'google' : r.engine) === filter)

  function engineCount(f: Filter): number {
    if (!engines) return 0
    if (f === 'all') return results.length
    return (engines as Record<string, number>)[f] ?? 0
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Search size={20} className="text-indigo-400" />
          Web Search
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Runs DDG, Bing, Yahoo, Startpage &amp; Google simultaneously — up to {num} combined results.
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={runSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Enter a search query…"
            className="w-full bg-[#0d1117] border border-[#1e2433] rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <select
          value={num}
          onChange={e => setNum(Number(e.target.value))}
          className="bg-[#0d1117] border border-[#1e2433] rounded-lg px-2 py-2.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
        >
          {[10, 20, 30, 50, 100].map(n => (
            <option key={n} value={n}>Max {n}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Engine summary + filter tabs */}
      {engines && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-slate-500">{results.length} result{results.length !== 1 ? 's' : ''} —</span>
          {FILTER_TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={clsx(
                'text-[10px] px-2.5 py-1 rounded-full border font-medium transition-colors',
                filter === key
                  ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                  : 'text-slate-400 border-[#1e2433] hover:border-slate-500',
              )}
            >
              {label} ({engineCount(key)})
            </button>
          ))}
          <button
            onClick={runSearch}
            disabled={loading}
            className="ml-auto p-1.5 text-slate-500 hover:text-white transition-colors"
            title="Re-run search"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 animate-pulse">
              <div className="h-3.5 bg-[#1e2433] rounded w-3/4 mb-2" />
              <div className="h-2.5 bg-[#1e2433] rounded w-1/3 mb-3" />
              <div className="h-2.5 bg-[#1e2433] rounded w-full mb-1" />
              <div className="h-2.5 bg-[#1e2433] rounded w-4/5" />
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {!loading && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((r, i) => {
            const importState = importing[r.url] ?? 'idle'
            const engKey = r.engine === 'google_cse' ? 'google' : r.engine
            return (
              <div
                key={i}
                className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 hover:border-[#2d3148] transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={clsx(
                        'text-[9px] px-1.5 py-0.5 rounded border font-mono uppercase tracking-wider flex-shrink-0',
                        ENGINE_COLORS[engKey] || 'bg-slate-500/10 text-slate-400 border-slate-500/20',
                      )}>
                        {ENGINE_LABELS[r.engine] ?? r.engine}
                      </span>
                      {r.source && (
                        <span className="text-[10px] text-slate-500 truncate">{r.source}</span>
                      )}
                      {r.published_at && (
                        <span className="text-[10px] text-slate-600">{r.published_at.slice(0, 10)}</span>
                      )}
                    </div>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm font-medium text-white group-hover:text-indigo-300 transition-colors leading-snug mb-1"
                    >
                      {r.title}
                    </a>
                    {r.snippet && (
                      <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">{r.snippet}</p>
                    )}
                    <p className="text-[10px] text-slate-600 mt-1 truncate">{r.url}</p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-slate-600 hover:text-slate-300 transition-colors"
                      title="Open"
                    >
                      <ExternalLink size={12} />
                    </a>
                    <button
                      onClick={() => importResult(r)}
                      disabled={importState !== 'idle'}
                      title="Import as article"
                      className={clsx(
                        'p-1.5 transition-colors rounded',
                        importState === 'done'    && 'text-emerald-400',
                        importState === 'error'   && 'text-red-400',
                        importState === 'loading' && 'text-slate-400',
                        importState === 'idle'    && 'text-slate-600 hover:text-indigo-400',
                      )}
                    >
                      {importState === 'loading' && <Loader2 size={12} className="animate-spin" />}
                      {importState === 'done'    && <CheckCircle2 size={12} />}
                      {importState === 'error'   && <AlertCircle size={12} />}
                      {importState === 'idle'    && <Download size={12} />}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && results.length === 0 && engines && (
        <div className="text-center py-16 text-slate-600 text-sm">
          No results found. Try a different query or check network access.
        </div>
      )}

      {!loading && results.length === 0 && !engines && (
        <div className="text-center py-20 text-slate-700 text-sm">
          Enter a query above to search across DDG, Bing, Yahoo, Startpage and Google simultaneously.
        </div>
      )}
    </div>
  )
}
