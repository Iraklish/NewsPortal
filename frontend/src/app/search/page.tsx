'use client'

import { useState, useRef, useEffect } from 'react'
import { searchApi, articlesApi, type WebSearchResult } from '@/lib/api'
import { Search, Loader2, ExternalLink, Download, CheckCircle2, AlertCircle, RefreshCw, ScrollText, CheckSquare, Square, X } from 'lucide-react'
import clsx from 'clsx'
import SummaryViewerModal from '@/components/SummaryViewerModal'
import { useLanguage } from '@/lib/language'

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
  const [loading, setLoading]     = useState(false)
  const [results, setResults]       = useState<WebSearchResult[]>([])
  const [perEngine, setPerEngine]   = useState<Record<string, WebSearchResult[]>>({})
  const [engines, setEngines]       = useState<Engines | null>(null)
  const [error, setError]           = useState('')
  const [filter, setFilter]         = useState<Filter>('all')
  const [importing, setImporting]   = useState<Record<string, 'idle' | 'loading' | 'done' | 'error'>>({})
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [summarizing, setSummarizing] = useState(false)
  const [summary, setSummary]       = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { apiLanguage } = useLanguage()

  useEffect(() => { inputRef.current?.focus() }, [])

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setError('')
    setResults([])
    setPerEngine({})
    setEngines(null)
    setFilter('all')
    setImporting({})
    setSelected(new Set())
    try {
      const data = await searchApi.search(q, 200)
      if (data.error) setError(data.error)
      setResults(data.results)
      setEngines(data.engines as Engines)
      setPerEngine(data.per_engine ?? {})
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

  // When a specific engine tab is active, show that engine's raw results
  // (before cross-engine dedup) so results are never empty just because
  // the same URL was already found by a higher-priority engine.
  const filtered = filter === 'all'
    ? results
    : (perEngine[filter] ?? results.filter(r => (r.engine === 'google_cse' ? 'google' : r.engine) === filter))

  function toggleSelect(url: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url); else next.add(url)
      return next
    })
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every(r => selected.has(r.url))

  function toggleSelectAll() {
    setSelected(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) filtered.forEach(r => next.delete(r.url))
      else filtered.forEach(r => next.add(r.url))
      return next
    })
  }

  async function summarizeSelected() {
    const chosen = results.filter(r => selected.has(r.url))
    // de-dupe by url in case the same url appears across engine views
    const seen = new Set<string>()
    const unique = chosen.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    if (unique.length === 0 || summarizing) return
    setSummarizing(true)
    setError('')
    setSummary(null)
    setSummaryOpen(true)
    try {
      const res = await searchApi.summarize({ query: query.trim(), results: unique, language: apiLanguage })
      setSummary(res.summary)
    } catch (err: unknown) {
      setSummaryOpen(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSummarizing(false)
    }
  }

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
          Runs DDG, Bing, Yahoo, Startpage &amp; Google simultaneously — sorted newest first.
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

      {/* Selection toolbar */}
      {!loading && filtered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 bg-[#0d1117] border border-[#1e2433] rounded-lg">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            {allFilteredSelected ? <CheckSquare size={14} className="text-indigo-400" /> : <Square size={14} />}
            {allFilteredSelected ? 'Clear all' : `Select all (${filtered.length})`}
          </button>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-white transition-colors"
              title="Clear selection"
            >
              <X size={11} /> {selected.size} selected
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={summarizeSelected}
            disabled={selected.size === 0 || summarizing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 rounded-lg text-xs text-white font-medium transition-colors"
            title="AI summary of the selected results"
          >
            {summarizing ? <Loader2 size={12} className="animate-spin" /> : <ScrollText size={12} />}
            Summarize{selected.size > 0 ? ` (${selected.size})` : ''}
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
                className={clsx(
                  'bg-[#0d1117] border rounded-xl p-4 transition-colors group',
                  selected.has(r.url) ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-[#1e2433] hover:border-[#2d3148]',
                )}
              >
                <div className="flex items-start gap-3">
                  <button
                    onClick={() => toggleSelect(r.url)}
                    className="mt-0.5 flex-shrink-0 text-slate-600 hover:text-indigo-400 transition-colors"
                    title={selected.has(r.url) ? 'Deselect' : 'Select'}
                    aria-label={selected.has(r.url) ? 'Deselect result' : 'Select result'}
                  >
                    {selected.has(r.url) ? <CheckSquare size={16} className="text-indigo-400" /> : <Square size={16} />}
                  </button>
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
                        <span className="text-[10px] text-indigo-400/70 font-medium flex-shrink-0">
                          {new Date(r.published_at.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(r.published_at)
                            ? r.published_at
                            : r.published_at + 'Z'
                          ).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
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

      {summaryOpen && (
        summarizing || summary == null ? (
          <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => !summarizing && setSummaryOpen(false)}>
            <div className="flex items-center gap-2 text-sm text-slate-300 bg-[#0d1117] border border-[#1e2433] rounded-xl px-5 py-4">
              <Loader2 size={16} className="animate-spin text-indigo-400" />
              Summarizing {selected.size} result{selected.size === 1 ? '' : 's'}…
            </div>
          </div>
        ) : (
          <SummaryViewerModal
            title={`Summary of ${selected.size} web result${selected.size === 1 ? '' : 's'}`}
            content={summary}
            onClose={() => setSummaryOpen(false)}
          />
        )
      )}
    </div>
  )
}
