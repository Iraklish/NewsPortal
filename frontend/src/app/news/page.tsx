'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  articlesApi,
  analysisApi,
  sourcesApi,
  settingsApi,
  resolveMediaUrl,
  type Article,
  type Analysis,
  type SummaryResponse,
} from '@/lib/api'
import ImpactBadge from '@/components/ImpactBadge'
import MessageContent from '@/components/MessageContent'
import SummaryMarkdown from '@/components/SummaryMarkdown'
import { applyHighlights } from '@/lib/highlight'
import {
  RefreshCw, Search, X, ExternalLink, Loader2, Sparkles,
  Send, ChevronDown, ChevronLeft, ChevronRight, Clock, Plus, BookOpen, Globe, Maximize2, Minimize2,
  CheckSquare, Square, Tag, LayoutGrid, Rows3, Trash2, ScrollText, ShieldCheck,
} from 'lucide-react'
import clsx from 'clsx'
import AddArticleModal from '@/components/AddArticleModal'
import { useLanguage } from '@/lib/language'

/** Strip HTML tags and decode common entities for safe plain-text display. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')           // remove tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')            // collapse whitespace
    .trim()
}

/** Sentinel value used in `tag` state to mean "articles with no tags". */
const TAG_NONE = '__none__'

/** Time-window filter options (value in hours; 0 = all time). */
const TIME_WINDOWS: { label: string; hours: number }[] = [
  { label: 'All time', hours: 0 },
  { label: 'Last 1 hour', hours: 1 },
  { label: 'Last 2 hours', hours: 2 },
  { label: 'Last 6 hours', hours: 6 },
  { label: 'Last 12 hours', hours: 12 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 2 days', hours: 48 },
  { label: 'Last week', hours: 168 },
  { label: 'Last 2 weeks', hours: 336 },
  { label: 'Last month', hours: 720 },
  { label: 'Last 2 months', hours: 1440 },
]

const ASPECT_PRESETS = [
  'Summary',
  'Detailed summary',
  'Related topics',
  'Economic impact',
  'Geopolitical factors',
  'Market analysis',
  'Risk assessment',
  'Factoring & supply chain',
  'Technology angle',
  'Energy & commodities',
]

const LANGUAGES = ['English', 'Hebrew', 'Russian', 'Georgian', 'French', 'German'] as const
type Lang = typeof LANGUAGES[number]

const LANG_INSTRUCTION: Record<Lang, string> = {
  English:  '',
  Hebrew:   ' — Respond entirely in Hebrew (עברית).',
  Russian:  ' — Respond entirely in Russian (Русский).',
  Georgian: ' — Respond entirely in Georgian (ქართული).',
  French:   ' — Respond entirely in French (Français).',
  German:   ' — Respond entirely in German (Deutsch).',
}

function fmtDate(s?: string): string {
  if (!s) return ''
  const ms = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)
    ? new Date(s).getTime()
    : new Date(s + 'Z').getTime()
  return new Date(ms).toLocaleString()
}

export default function NewsPage() {
  const [articles, setArticles] = useState<Article[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [category, setCategory] = useState<string>('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [tag, setTag] = useState<string>('')
  const [hours, setHours] = useState<number>(1)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [selected, setSelected] = useState<Article | null>(null)
  const [adding, setAdding] = useState(false)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [status, setStatus] = useState<{ last_fetch_at?: string | null; next_fetch_at?: string | null; ok: number; total: number; enabled: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkTagging, setBulkTagging] = useState(false)
  const [bulkTagMsg, setBulkTagMsg] = useState('')
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryData, setSummaryData] = useState<SummaryResponse | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryMaximized, setSummaryMaximized] = useState(false)
  const [summarySearch, setSummarySearch] = useState('')
  const [summaryMatchCount, setSummaryMatchCount] = useState(0)
  const summaryContentRef = useRef<HTMLDivElement>(null)
  const { apiLanguage } = useLanguage()
  const [page, setPage] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Grid / limit settings — start with SSR-safe defaults; localStorage applied after mount
  const [gridCols, setGridColsRaw] = useState<number>(2)
  const [gridRows, setGridRowsRaw] = useState<number>(10)

  function setGridCols(n: number) {
    setGridColsRaw(n)
    localStorage.setItem('news_grid_cols', String(n))
    setPage(0)
    load({ limit: n * gridRows, page: 0 })
  }

  function setGridRows(n: number) {
    setGridRowsRaw(n)
    localStorage.setItem('news_grid_rows', String(n))
    setPage(0)
    load({ limit: gridCols * n, page: 0 })
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function reloadTags() {
    articlesApi.tags().then(setAllTags).catch(() => {})
  }

  async function loadStatus() {
    try { setStatus(await sourcesApi.status()) } catch {}
  }

  async function load(params?: { category?: string; q?: string; tag?: string; hours?: number; limit?: number; page?: number }) {
    setLoading(true)
    setLoadError(null)
    const effCategory = params?.category ?? category
    const effQuery = params?.q ?? query
    const effTag = params?.tag !== undefined ? params.tag : tag
    const effHours = params?.hours !== undefined ? params.hours : hours
    const effLimit = params?.limit ?? (gridCols * gridRows)
    const effPage = params?.page !== undefined ? params.page : page
    const skip = effPage * effLimit
    const isUntagged = effTag === TAG_NONE
    try {
      const [data, countRes] = await Promise.all([
        articlesApi.list({
          skip, limit: effLimit, category: effCategory, q: effQuery,
          tag: isUntagged ? undefined : effTag,
          untagged: isUntagged || undefined,
          hours: effHours || undefined,
        }),
        articlesApi.count({
          category: effCategory, q: effQuery,
          tag: isUntagged ? undefined : effTag,
          untagged: isUntagged || undefined,
          hours: effHours || undefined,
        }),
      ])
      setArticles(data)
      setTotalCount(countRes.count)
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to reach the backend. Is it running?')
    } finally {
      setLoading(false)
    }
  }

  function goToPage(n: number) {
    setPage(n)
    load({ page: n })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  useEffect(() => {
    // Read persisted grid settings client-side (avoids SSR/hydration mismatch)
    const savedCols = parseInt(localStorage.getItem('news_grid_cols') || '2', 10)
    const savedRows = parseInt(localStorage.getItem('news_grid_rows') || '10', 10)
    const cols = [1, 2, 3, 4].includes(savedCols) ? savedCols : 2
    const rows = [5, 10, 20, 50].includes(savedRows) ? savedRows : 10
    setGridColsRaw(cols)
    setGridRowsRaw(rows)

    // Pre-select category from URL (?category=entertainment etc.)
    const urlParams = new URLSearchParams(window.location.search)
    const urlCategory = urlParams.get('category') || ''
    if (urlCategory) setCategory(urlCategory)

    articlesApi.categories().then(setCategories).catch(() => {})
    reloadTags()
    load({ limit: cols * rows, category: urlCategory })  // pass explicit limit — state update is async
    loadStatus()
    const id = setInterval(loadStatus, 30000)
    return () => clearInterval(id)
  }, [])

  // Debounced search — always resets to page 0
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPage(0)
      load({ q: query, page: 0 })
    }, 350)
  }, [query])

  function pickCategory(c: string) {
    setCategory(c)
    setPage(0)
    load({ category: c, q: query, tag, page: 0 })
  }

  function pickTag(t: string) {
    setTag(t)
    setPage(0)
    load({ tag: t, category, q: query, page: 0 })
  }

  function pickWindow(h: number) {
    setHours(h)
    setPage(0)
    load({ hours: h, category, q: query, tag, page: 0 })
  }

  async function refreshFeeds() {
    setRefreshing(true)
    setRefreshMsg('')
    setPage(0)
    try {
      const res = await articlesApi.fetchAll()
      setRefreshMsg(`Fetched ${res.fetched} new articles`)
      await load({ page: 0 })
      await loadStatus()
    } catch (e: unknown) {
      setRefreshMsg('Fetch failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setRefreshing(false)
      setTimeout(() => setRefreshMsg(''), 5000)
    }
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function bulkAutoTagSelected() {
    if (selectedIds.size === 0) return
    setBulkTagging(true)
    setBulkTagMsg('')
    try {
      const res = await articlesApi.autoTagByIds(Array.from(selectedIds))
      setBulkTagMsg(`Tagged ${res.tagged} article${res.tagged === 1 ? '' : 's'}${res.errors ? ` (${res.errors} errors)` : ''}`)
      setSelectedIds(new Set())
      await load()
      reloadTags()
    } catch (e: unknown) {
      setBulkTagMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBulkTagging(false)
      setTimeout(() => setBulkTagMsg(''), 5000)
    }
  }

  async function bulkDeleteSelected() {
    if (selectedIds.size === 0) return
    const n = selectedIds.size
    if (!window.confirm(`Delete ${n} selected article${n === 1 ? '' : 's'}? This cannot be undone.`)) return
    setBulkDeleting(true)
    setBulkTagMsg('')
    try {
      const res = await articlesApi.deleteByIds(Array.from(selectedIds))
      setBulkTagMsg(`Deleted ${res.deleted} article${res.deleted === 1 ? '' : 's'}`)
      setSelectedIds(new Set())
      if (selected && selectedIds.has(selected.id)) setSelected(null)
      await load()
      reloadTags()
    } catch (e: unknown) {
      setBulkTagMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBulkDeleting(false)
      setTimeout(() => setBulkTagMsg(''), 5000)
    }
  }

  // Memoize the rendered summary so typing in the find box doesn't re-render the
  // markdown subtree (which would wipe the injected highlight <mark> nodes).
  const summaryBody = useMemo(() => {
    if (!summaryData) return null
    return (
      <>
        <SummaryMarkdown content={summaryData.summary} />
        {summaryData.key_themes?.length > 0 && (
          <div className="mt-5 pt-4 border-t border-[#1e2433]">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Key themes</p>
            <div className="flex flex-wrap gap-1.5">
              {summaryData.key_themes.map((t, i) => (
                <span key={i} className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/30 rounded text-xs text-indigo-300">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    )
  }, [summaryData])

  // Re-apply the in-summary highlight whenever the term, data, or layout changes.
  useEffect(() => {
    const el = summaryContentRef.current
    if (!summaryOpen || !el) return
    setSummaryMatchCount(applyHighlights(el, summarySearch))
  }, [summarySearch, summaryOpen, summaryData, summaryMaximized])

  async function summarizeSelected() {
    if (selectedIds.size === 0) return
    setSummarizing(true)
    setSummaryError('')
    setSummaryData(null)
    setSummaryOpen(true)
    setSummarySearch('')
    try {
      const res = await analysisApi.summarize({
        article_ids: Array.from(selectedIds),
        max_articles: 0,
        language: apiLanguage,
      })
      setSummaryData(res)
    } catch (e: unknown) {
      setSummaryError(e instanceof Error ? e.message : String(e))
    } finally {
      setSummarizing(false)
    }
  }

  // Summarize the currently displayed (filtered) results, mapping the active
  // filters onto the summary endpoint. Honors category / keyword / tag + window.
  // Note: the trailing time window slides with "now", and articles arrive in
  // bursts, so we also refresh the matching count at the same moment to keep the
  // "N matching" label and the summary's article count in sync.
  async function summarizeDisplayed() {
    setSummarizing(true)
    setSummaryError('')
    setSummaryData(null)
    setSummaryOpen(true)
    setSummarySearch('')
    try {
      const isUntagged = tag === TAG_NONE
      let filter_type: 'tag' | 'category' | 'keyword' | undefined
      let filter_value: string | undefined
      if (query.trim()) { filter_type = 'keyword'; filter_value = query.trim() }
      else if (tag && !isUntagged) { filter_type = 'tag'; filter_value = tag }
      else if (category) { filter_type = 'category'; filter_value = category }

      const [res] = await Promise.all([
        analysisApi.summarize({
          filter_type,
          filter_value,
          time_window_hours: hours,
          max_articles: 0,
          language: apiLanguage,
        }),
        // Re-count matching articles at the same instant so the header label
        // reflects the same snapshot the summary was built from.
        articlesApi.count({
          category: category || undefined,
          q: query.trim() || undefined,
          tag: isUntagged ? undefined : (tag || undefined),
          untagged: isUntagged || undefined,
          hours: hours || undefined,
        }).then(c => setTotalCount(c.count)).catch(() => {}),
      ])
      setSummaryData(res)
    } catch (e: unknown) {
      setSummaryError(e instanceof Error ? e.message : String(e))
    } finally {
      setSummarizing(false)
    }
  }

  function relTime(iso?: string | null): string {
    if (!iso) return 'never'
    const ms = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? new Date(iso).getTime() : new Date(iso + 'Z').getTime()
    const diff = Date.now() - ms
    if (diff < 0) {
      // future (next fetch)
      const future = Math.abs(diff)
      const min = Math.round(future / 60000)
      if (min < 1) return 'in <1 min'
      if (min < 60) return `in ${min} min`
      return `in ${Math.round(min / 60)} h`
    }
    const min = Math.round(diff / 60000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min} min ago`
    const h = Math.round(min / 60)
    if (h < 24) return `${h} h ago`
    return `${Math.round(h / 24)} d ago`
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            News
            {totalCount != null && (
              <span className="text-xs font-normal px-2 py-0.5 bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded-full">
                {totalCount.toLocaleString()}{(category || query || tag || hours > 0) ? ' matching' : ' total'}
              </span>
            )}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Live feed from {categories.length || 6} categories
            {totalCount != null && totalCount > gridCols * gridRows && (
              <>
                {' · '}
                {(page * gridCols * gridRows + 1).toLocaleString()}–{Math.min((page + 1) * gridCols * gridRows, totalCount).toLocaleString()}
                {' of '}{totalCount.toLocaleString()}
              </>
            )}
            . Click any article to analyze or ask a question.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {status && (
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#1e2433] rounded-lg text-xs"
              title={status.last_fetch_at ? `${status.ok}/${status.enabled} feeds returning content — next scheduled ${relTime(status.next_fetch_at)}` : 'No fetch has run yet'}
            >
              <Clock size={11} className="text-slate-500" />
              <span className="text-slate-500">Last fetch:</span>
              <span className="text-slate-200 font-medium">{relTime(status.last_fetch_at)}</span>
              <span className="text-slate-600 ml-1">· {status.ok}/{status.enabled} feeds</span>
            </div>
          )}
          {refreshMsg && (
            <span className="text-xs text-emerald-400">{refreshMsg}</span>
          )}
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded-lg text-sm text-slate-300 hover:text-white transition-colors"
          >
            <Plus size={14} /> Add Article
          </button>
          <button
            onClick={refreshFeeds}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded-lg text-sm text-slate-300 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Fetching…' : 'Fetch Now'}
          </button>
          <button
            onClick={summarizeDisplayed}
            disabled={summarizing}
            title="Summarize the currently displayed results (current filters + time window)"
            aria-label="Summarize displayed results"
            className="flex items-center justify-center p-2 bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/40 hover:border-indigo-500/60 rounded-lg text-indigo-300 hover:text-white transition-colors disabled:opacity-50"
          >
            {summarizing ? <Loader2 size={16} className="animate-spin" /> : <ScrollText size={16} />}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search title, summary, content, or tag…"
            className="w-full bg-[#0d1117] border border-[#1e2433] rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <select
          value={category}
          onChange={e => pickCategory(e.target.value)}
          className="bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-indigo-500"
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={hours}
          onChange={e => pickWindow(Number(e.target.value))}
          title="Filter by how recently articles were published"
          className={clsx(
            'bg-[#0d1117] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500',
            hours > 0 ? 'border-indigo-500/50 text-indigo-300' : 'border-[#1e2433] text-slate-300',
          )}
        >
          {TIME_WINDOWS.map(w => (
            <option key={w.hours} value={w.hours}>{w.label}</option>
          ))}
        </select>
        <TagFilter value={tag} onChange={pickTag} allTags={allTags} />
      </div>

      {/* Grid / limit controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Columns */}
        <div className="flex items-center gap-1.5">
          <LayoutGrid size={12} className="text-slate-500 flex-shrink-0" />
          <span className="text-[11px] text-slate-500 font-medium mr-0.5">Columns</span>
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              onClick={() => setGridCols(n)}
              className={clsx(
                'w-7 h-7 rounded border text-xs font-medium transition-colors',
                gridCols === n
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-[#0d1117] border-[#1e2433] text-slate-400 hover:border-indigo-500/50 hover:text-white',
              )}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-[#1e2433] self-center flex-shrink-0" />

        {/* Rows */}
        <div className="flex items-center gap-1.5">
          <Rows3 size={12} className="text-slate-500 flex-shrink-0" />
          <span className="text-[11px] text-slate-500 font-medium mr-0.5">Rows</span>
          {[5, 10, 20, 50].map(n => (
            <button
              key={n}
              onClick={() => setGridRows(n)}
              className={clsx(
                'min-w-[28px] h-7 px-2 rounded border text-xs font-medium transition-colors',
                gridRows === n
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-[#0d1117] border-[#1e2433] text-slate-400 hover:border-indigo-500/50 hover:text-white',
              )}
            >
              {n}
            </button>
          ))}
        </div>

        <span className="text-[11px] text-slate-600 flex-shrink-0">
          = {gridCols * gridRows} per page
        </span>
      </div>

      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-teal-500/10 border border-teal-500/30 rounded-lg flex-wrap">
          <Tag size={12} className="text-teal-400 flex-shrink-0" />
          <span className="text-xs font-semibold text-teal-300 flex-shrink-0">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => setSelectedIds(new Set(articles.map(a => a.id)))}
            className="text-xs text-slate-400 hover:text-white underline underline-offset-2 flex-shrink-0"
          >
            All visible ({articles.length})
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-slate-500 hover:text-white flex-shrink-0"
          >
            <X size={12} />
          </button>
          <div className="flex-1" />
          {bulkTagMsg && <span className="text-xs text-teal-400 flex-shrink-0">{bulkTagMsg}</span>}
          <button
            onClick={summarizeSelected}
            disabled={bulkTagging || bulkDeleting || summarizing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/40 disabled:opacity-50 border border-indigo-500/30 rounded text-xs text-indigo-300 font-medium transition-colors flex-shrink-0"
          >
            {summarizing ? <Loader2 size={11} className="animate-spin" /> : <ScrollText size={11} />}
            Summarize selected
          </button>
          <button
            onClick={bulkAutoTagSelected}
            disabled={bulkTagging || bulkDeleting || summarizing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600/20 hover:bg-teal-600/40 disabled:opacity-50 border border-teal-500/30 rounded text-xs text-teal-300 font-medium transition-colors flex-shrink-0"
          >
            {bulkTagging ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            Auto-tag selected
          </button>
          <button
            onClick={bulkDeleteSelected}
            disabled={bulkTagging || bulkDeleting || summarizing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 disabled:opacity-50 border border-red-500/30 rounded text-xs text-red-300 font-medium transition-colors flex-shrink-0"
          >
            {bulkDeleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
            Delete selected
          </button>
        </div>
      )}
      {!selectedIds.size && bulkTagMsg && (
        <p className="text-xs text-teal-400 mb-3">{bulkTagMsg}</p>
      )}

      {/* Backend connection error */}
      {loadError && (
        <div className="flex items-center gap-3 px-4 py-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-sm">
          <span className="text-red-400 flex-1">{loadError}</span>
          <button
            onClick={() => load()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 rounded-lg text-xs text-red-300 font-medium transition-colors"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-24 bg-[#0d1117] border border-[#1e2433] rounded-xl animate-pulse" />
          ))}
        </div>
      ) : articles.length === 0 && !loadError ? (
        <div className="text-center py-20 text-slate-500">
          <p className="text-lg">No articles match these filters.</p>
        </div>
      ) : (
        <div className={clsx(
          'grid gap-3',
          gridCols === 1 && 'grid-cols-1',
          gridCols === 2 && 'grid-cols-1 sm:grid-cols-2',
          gridCols === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
          gridCols === 4 && 'grid-cols-2 lg:grid-cols-4',
        )}>
          {articles.map(a => (
            <ArticleCard
              key={a.id}
              article={a}
              onClick={() => setSelected(a)}
              selected={selectedIds.has(a.id)}
              onSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && totalCount != null && totalCount > gridCols * gridRows && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded-lg text-sm text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={14} />
            Prev
          </button>

          {/* Page number pills */}
          <div className="flex items-center gap-1">
            {(() => {
              const total = Math.ceil(totalCount / (gridCols * gridRows))
              const pages: (number | '…')[] = []
              if (total <= 7) {
                for (let i = 0; i < total; i++) pages.push(i)
              } else {
                pages.push(0)
                if (page > 2) pages.push('…')
                for (let i = Math.max(1, page - 1); i <= Math.min(total - 2, page + 1); i++) pages.push(i)
                if (page < total - 3) pages.push('…')
                pages.push(total - 1)
              }
              return pages.map((p, i) =>
                p === '…' ? (
                  <span key={`e${i}`} className="w-7 text-center text-slate-600 text-xs">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => goToPage(p as number)}
                    className={clsx(
                      'w-7 h-7 rounded border text-xs font-medium transition-colors',
                      page === p
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-[#0d1117] border-[#1e2433] text-slate-400 hover:border-indigo-500/50 hover:text-white',
                    )}
                  >
                    {(p as number) + 1}
                  </button>
                )
              )
            })()}
          </div>

          <button
            onClick={() => goToPage(page + 1)}
            disabled={(page + 1) * (gridCols * gridRows) >= totalCount}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded-lg text-sm text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {selected && (
        <ArticleDetail
          article={selected}
          onClose={() => setSelected(null)}
        />
      )}

      {adding && (
        <AddArticleModal
          categories={categories}
          onClose={() => setAdding(false)}
          onAdded={() => { load(); articlesApi.categories().then(setCategories).catch(() => {}) }}
        />
      )}

      {summaryOpen && (
        <div
          className={clsx(
            'fixed inset-0 z-[60] bg-black/70 flex items-start justify-center overflow-y-auto',
            summaryMaximized ? 'p-0' : 'p-4 md:p-8',
          )}
          onClick={() => setSummaryOpen(false)}
        >
          <div
            className={clsx(
              'bg-[#0d1117] border border-[#1e2433] shadow-2xl flex flex-col',
              summaryMaximized
                ? 'w-full min-h-screen rounded-none'
                : 'w-full max-w-3xl my-auto rounded-2xl',
            )}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2433]">
              <div className="flex items-center gap-2 min-w-0">
                <ScrollText size={16} className="text-indigo-400 flex-shrink-0" />
                <h2 className="text-sm font-bold text-white truncate">
                  Summary of {summaryData?.article_count ?? selectedIds.size} article{(summaryData?.article_count ?? selectedIds.size) === 1 ? '' : 's'}
                </h2>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {/* Quick find within the summary */}
                <div className="relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    value={summarySearch}
                    onChange={e => setSummarySearch(e.target.value)}
                    placeholder="Find in summary…"
                    className="w-32 sm:w-44 bg-[#0a0f1e] border border-[#1e2433] rounded-lg pl-7 pr-12 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                  {summarySearch.trim() && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 tabular-nums">
                      {summaryMatchCount}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setSummaryMaximized(m => !m)}
                  title={summaryMaximized ? 'Restore' : 'Maximize'}
                  aria-label={summaryMaximized ? 'Restore' : 'Maximize'}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                >
                  {summaryMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button
                  onClick={() => setSummaryOpen(false)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div ref={summaryContentRef} className={clsx('p-5 overflow-y-auto flex-1', summaryMaximized ? '' : 'max-h-[70vh]')}>
              {summarizing && (
                <div className="flex items-center gap-2 text-sm text-slate-400 py-8 justify-center">
                  <Loader2 size={16} className="animate-spin" />
                  Generating summary…
                </div>
              )}
              {!summarizing && summaryError && (
                <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                  {summaryError}
                </div>
              )}
              {!summarizing && summaryBody}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tag filter combobox ───────────────────────────────────────────────────────

function TagFilter({
  value,
  onChange,
  allTags,
}: {
  value: string
  onChange: (v: string) => void
  allTags: string[]
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onMD(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMD)
    return () => document.removeEventListener('mousedown', onMD)
  }, [])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
    else setSearch('')
  }, [open])

  const TOP_N = 20
  const displayedTags = search.trim()
    ? allTags.filter(t => t.toLowerCase().includes(search.toLowerCase())).slice(0, 30)
    : allTags.slice(0, TOP_N)

  function select(v: string) { onChange(v); setOpen(false) }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const s = search.trim()
      if (s) {
        const exact = displayedTags.find(t => t.toLowerCase() === s.toLowerCase())
        select(exact ?? s)
      }
    }
    if (e.key === 'Escape') setOpen(false)
  }

  const label =
    value === TAG_NONE ? 'No Tags' :
    value             ? value      :
                        'All Tags'

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'bg-[#0d1117] border rounded-lg px-3 py-2 text-sm flex items-center gap-2 min-w-[130px] transition-colors focus:outline-none',
          open ? 'border-teal-500/60 text-white' : 'border-[#1e2433] text-slate-300 hover:border-teal-500/40',
        )}
      >
        <span className="flex-1 text-left truncate max-w-[120px]">{label}</span>
        <ChevronDown size={12} className={clsx('text-slate-500 transition-transform flex-shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 bg-[#0d1117] border border-[#1e2433] rounded-xl shadow-2xl w-56 overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-[#1e2433]">
            <div className="relative">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search or type a tag…"
                className="w-full bg-[#161b27] border border-[#1e2433] rounded-lg pl-7 pr-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-teal-500/50 transition-colors"
              />
            </div>
          </div>

          {/* List */}
          <div className="max-h-64 overflow-y-auto py-1">
            {/* All */}
            <button
              onClick={() => select('')}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2',
                !value ? 'text-teal-400 bg-teal-500/10' : 'text-slate-300 hover:bg-white/5',
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 flex-shrink-0" />
              All Tags
            </button>

            {/* None */}
            <button
              onClick={() => select(TAG_NONE)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2',
                value === TAG_NONE ? 'text-teal-400 bg-teal-500/10' : 'text-slate-400 hover:bg-white/5',
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full border border-slate-500 flex-shrink-0" />
              No Tags
            </button>

            {/* Top / filtered tags */}
            {displayedTags.length > 0 && (
              <>
                <div className="px-3 py-1 mt-0.5 border-t border-[#1e2433]">
                  <span className="text-[10px] text-slate-600 uppercase tracking-wider">
                    {search.trim() ? 'Matches' : `Top ${Math.min(TOP_N, displayedTags.length)}`}
                  </span>
                </div>
                {displayedTags.map(t => (
                  <button
                    key={t}
                    onClick={() => select(t)}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2',
                      value === t ? 'text-teal-400 bg-teal-500/10' : 'text-slate-300 hover:bg-white/5',
                    )}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-teal-600/50 flex-shrink-0" />
                    <span className="truncate">{t}</span>
                  </button>
                ))}
              </>
            )}

            {search.trim() && displayedTags.length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-600 italic">No tags match &quot;{search}&quot;</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


function ArticleCard({
  article, onClick, selected, onSelect,
}: {
  article: Article
  onClick: () => void
  selected?: boolean
  onSelect?: (id: number) => void
}) {
  return (
    <div
      className={clsx(
        'relative group text-left bg-[#0d1117] border rounded-xl p-4 transition-colors flex gap-3',
        selected
          ? 'border-teal-500/50 bg-teal-500/[0.04]'
          : 'border-[#1e2433] hover:border-indigo-500/40',
      )}
    >
      {/* Selection checkbox — top-right, visible on hover or when selected */}
      <button
        onClick={e => { e.stopPropagation(); onSelect?.(article.id) }}
        title={selected ? 'Deselect' : 'Select for bulk action'}
        className={clsx(
          'absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded border flex items-center justify-center transition-all',
          selected
            ? 'bg-teal-500 border-teal-500 opacity-100'
            : 'bg-[#0d1117] border-slate-600/60 opacity-0 group-hover:opacity-100',
        )}
      >
        {selected
          ? <CheckSquare size={13} className="text-white" />
          : <Square size={13} className="text-slate-500" />}
      </button>

      {/* Clickable card body */}
      <div className="flex gap-3 flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        {article.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolveMediaUrl(article.image_url)}
            alt=""
            className="w-20 h-20 object-cover rounded-lg flex-shrink-0"
            onError={e => (e.currentTarget.style.display = 'none')}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {article.category && (
              <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded uppercase tracking-wider">{article.category}</span>
            )}
            {article.is_analyzed && (
              <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">analyzed</span>
            )}
            <span className="text-[10px] text-slate-600">{article.source}</span>
          </div>
          <h3 className="text-sm font-semibold text-white leading-snug line-clamp-2 mb-1">{article.title}</h3>
          {article.summary && (
            <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">{stripHtml(article.summary)}</p>
          )}
          {article.tags && article.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {article.tags.slice(0, 4).map(t => (
                <span key={t} className="text-[9px] px-1.5 py-0 bg-teal-500/10 text-teal-400 border border-teal-500/20 rounded-full leading-5">{t}</span>
              ))}
              {article.tags.length > 4 && <span className="text-[9px] text-slate-600 leading-5">+{article.tags.length - 4}</span>}
            </div>
          )}
          <p className="text-[10px] text-slate-600 mt-1.5">{fmtDate(article.published_at || article.fetched_at)}</p>
        </div>
      </div>
    </div>
  )
}

// ── Tags editor ───────────────────────────────────────────────────────────────

function TagsEditor({
  articleId,
  initialTags,
  onTagsChanged,
}: {
  articleId: number
  initialTags?: string[]
  onTagsChanged?: (tags: string[]) => void
}) {
  const [tags, setTags] = useState<string[]>(initialTags || [])
  const [inputVal, setInputVal] = useState('')
  const [autoTagging, setAutoTagging] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Collapse by default on small (mobile) viewports to save vertical space.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) setCollapsed(true)
  }, [])

  async function saveTags(newTags: string[]) {
    setTags(newTags)
    onTagsChanged?.(newTags)
    try { await articlesApi.setTags(articleId, newTags) } catch {}
  }

  function addTag() {
    const t = inputVal.trim()
    if (!t || tags.includes(t)) return
    setInputVal('')
    saveTags([...tags, t])
  }

  async function autoTag() {
    setAutoTagging(true)
    try {
      const res = await articlesApi.autoTag(articleId)
      setTags(res.tags)
      onTagsChanged?.(res.tags)
    } catch {}
    finally { setAutoTagging(false) }
  }

  return (
    <div className="bg-[#0a0f1e] rounded-lg p-3 border border-[#1e2433]">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          title={collapsed ? 'Expand tags' : 'Collapse tags'}
        >
          {collapsed ? <ChevronRight size={12} className="text-teal-500 flex-shrink-0" /> : <ChevronDown size={12} className="text-teal-500 flex-shrink-0" />}
          <span className="text-[10px] font-bold text-teal-500 uppercase tracking-wider">Topic Tags</span>
          {tags.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 bg-teal-500/10 text-teal-400 border border-teal-500/20 rounded-full leading-none">{tags.length}</span>
          )}
        </button>
        <button
          onClick={autoTag}
          disabled={autoTagging}
          title="Auto-extract English tags using AI (works for any language)"
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 bg-teal-500/10 text-teal-400 border border-teal-500/20 rounded hover:bg-teal-500/20 transition-colors disabled:opacity-50 flex-shrink-0"
        >
          {autoTagging ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
          Auto-tag
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2 mt-2 min-h-[22px]">
            {tags.length === 0 && (
              <span className="text-[10px] text-slate-600 italic">No tags yet — add manually or click Auto-tag</span>
            )}
            {tags.map(t => (
              <span
                key={t}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 bg-teal-500/10 text-teal-300 border border-teal-500/20 rounded-full"
              >
                {t}
                <button
                  onClick={() => saveTags(tags.filter(x => x !== t))}
                  className="text-teal-500 hover:text-teal-200 ml-0.5 leading-none"
                  title={`Remove tag "${t}"`}
                >×</button>
              </span>
            ))}
          </div>

          <div className="flex gap-1.5">
            <input
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
              placeholder="Add a tag…"
              className="flex-1 bg-[#0d1117] border border-[#1e2433] rounded px-2 py-1 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-teal-500/50 transition-colors"
            />
            <button
              onClick={addTag}
              disabled={!inputVal.trim()}
              className="px-2.5 py-1 text-[11px] bg-teal-600/20 hover:bg-teal-600/30 text-teal-300 rounded border border-teal-500/20 disabled:opacity-40 transition-colors"
            >
              Add
            </button>
          </div>
        </>
      )}
    </div>
  )
}

type TimelineItem =
  | { kind: 'user'; id: string; at: number; content: string }
  | { kind: 'assistant'; id: string; at: number; content: string }
  | { kind: 'analysis'; id: string; at: number; analysis: Analysis }
  | { kind: 'pending-chat'; id: string; at: number }
  | { kind: 'pending-analyze'; id: string; at: number; focus?: string }
  | { kind: 'pending-summarize'; id: string; at: number }
  | { kind: 'pending-factcheck'; id: string; at: number }

function ArticleDetail({ article, onClose }: { article: Article; onClose: () => void }) {
  // Unified timeline of user prompts, AI chat replies, and persisted analyses,
  // sorted chronologically (oldest first → newest at the bottom, chat-style).
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [language, setLanguage] = useState<Lang>('English')
  const [maximized, setMaximized] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [titleExpanded, setTitleExpanded] = useState(false)
  const [summarizePrompt, setSummarizePrompt] = useState(
    'Please provide a concise summary of this article. Cover: the main topic, key facts or figures, who is involved, why it matters, and any immediate implications.',
  )
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load the (possibly customized) Summarize-button prompt from settings.
  useEffect(() => {
    settingsApi.get()
      .then(s => { if (s.article_summarize_prompt) setSummarizePrompt(s.article_summarize_prompt) })
      .catch(() => {})
  }, [])

  // Load existing analyses for this article into the timeline.
  useEffect(() => {
    analysisApi
      .listForArticle(article.id)
      .then(rows => {
        const items: TimelineItem[] = rows.map(a => ({
          kind: 'analysis' as const,
          id: `a-${a.id}`,
          at: a.created_at ? new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime() : Date.now(),
          analysis: a,
        }))
        items.sort((x, y) => x.at - y.at)
        setTimeline(items)
      })
      .catch(() => {})
  }, [article.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [timeline])

  // Build the chat-style history for Ask requests, ignoring analysis rows.
  function chatHistory(): { role: string; content: string }[] {
    return timeline
      .filter(it => it.kind === 'user' || it.kind === 'assistant')
      .map(it => ({ role: it.kind === 'user' ? 'user' : 'assistant', content: (it as { content: string }).content }))
  }

  async function send(mode: 'ask' | 'analyze' | 'summarize' | 'factcheck') {
    const langSuffix = LANG_INSTRUCTION[language]
    const SUMMARIZE_PROMPT = summarizePrompt + langSuffix
    const rawText = mode === 'summarize' ? SUMMARIZE_PROMPT : input.trim()
    // For ask/analyze, append language instruction to the effective prompt but keep the display label clean
    const text = (mode !== 'summarize' && langSuffix) ? rawText + langSuffix : rawText
    if (mode !== 'factcheck' && (!text || busy)) return
    if (busy) return
    setBusy(true)
    setError('')
    const now = Date.now()
    const pendingId = `p-${now}`

    if (mode === 'summarize') {
      setTimeline(prev => [...prev, { kind: 'pending-summarize', id: pendingId, at: now }])
    } else if (mode === 'factcheck') {
      setTimeline(prev => [...prev, { kind: 'pending-factcheck', id: pendingId, at: now }])
    } else {
      const userItem: TimelineItem = { kind: 'user', id: `u-${now}`, at: now, content: rawText }
      const pending: TimelineItem = mode === 'ask'
        ? { kind: 'pending-chat', id: pendingId, at: now + 1 }
        : { kind: 'pending-analyze', id: pendingId, at: now + 1, focus: rawText }
      setTimeline(prev => [...prev, userItem, pending])
      setInput('')
    }

    try {
      if (mode === 'factcheck') {
        const res = await analysisApi.factCheckArticle(article.id)
        setTimeline(prev => prev
          .filter(it => it.id !== pendingId)
          .concat({ kind: 'assistant', id: `m-${Date.now()}`, at: Date.now(), content: res.response })
        )
      } else if (mode === 'ask' || mode === 'summarize') {
        const history = mode === 'ask' ? chatHistory() : []
        const res = await analysisApi.askAboutArticle(article.id, text, history)
        setTimeline(prev => prev
          .filter(it => it.id !== pendingId)
          .concat({ kind: 'assistant', id: `m-${Date.now()}`, at: Date.now(), content: res.response })
        )
      } else {
        const result = await analysisApi.analyzeArticle(article.id, text)
        setTimeline(prev => prev
          .filter(it => it.id !== pendingId)
          .concat({
            kind: 'analysis',
            id: `a-${result.id}`,
            at: result.created_at ? new Date(result.created_at.endsWith('Z') ? result.created_at : result.created_at + 'Z').getTime() : Date.now(),
            analysis: result,
          })
        )
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setTimeline(prev => prev
        .filter(it => it.id !== pendingId)
        .concat({ kind: 'assistant', id: `e-${Date.now()}`, at: Date.now(), content: `Error: ${msg}` })
      )
    } finally {
      setBusy(false)
    }
  }

  const analyzeCount = timeline.filter(it => it.kind === 'analysis').length

  return (
    <div
      className={clsx('fixed inset-0 z-50 bg-black/70 flex items-center justify-center', maximized ? 'p-0' : 'p-4')}
      onClick={maximized ? undefined : onClose}
    >
      <div
        className={clsx(
          'bg-[#0d1117] border border-[#1e2433] overflow-hidden flex flex-col',
          maximized ? 'w-full h-full' : 'rounded-2xl w-full max-w-4xl max-h-[90vh]',
        )}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-[#1e2433] flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {article.category && (
                <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded uppercase tracking-wider">{article.category}</span>
              )}
              <span className="text-xs text-slate-500">{article.source}</span>
              <span className="text-xs text-slate-600">·</span>
              <span className="text-xs text-slate-500">{fmtDate(article.published_at || article.fetched_at)}</span>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-500 hover:text-indigo-400 transition-colors ml-1"
              >
                <ExternalLink size={12} />
              </a>
              {analyzeCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded ml-auto">
                  {analyzeCount} analysis{analyzeCount === 1 ? '' : 'es'}
                </span>
              )}
            </div>
            <button
              onClick={() => setTitleExpanded(v => !v)}
              title={titleExpanded ? 'Collapse title' : 'Expand title'}
              className="flex items-start gap-1.5 text-left w-full group"
            >
              {titleExpanded
                ? <ChevronDown size={16} className="text-slate-500 group-hover:text-white flex-shrink-0 mt-1" />
                : <ChevronRight size={16} className="text-slate-500 group-hover:text-white flex-shrink-0 mt-1" />}
              <h2 className={clsx('text-lg font-bold text-white leading-snug', !titleExpanded && 'line-clamp-1')}>
                {article.title}
              </h2>
            </button>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setMaximized(m => !m)}
              title={maximized ? 'Restore' : 'Maximize'}
              className="p-1.5 text-slate-500 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white hover:bg-white/10 rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Post image */}
          {article.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={resolveMediaUrl(article.image_url)}
              alt=""
              className="w-full max-h-80 object-contain rounded-lg bg-[#0a0f1e] border border-[#1e2433]"
              onError={e => (e.currentTarget.style.display = 'none')}
            />
          )}
          {/* Article summary / content */}
          {(article.summary || article.content) && (
            <div className="bg-[#0a0f1e] rounded-lg p-4 border border-[#1e2433]">
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                {stripHtml(article.summary || article.content?.slice(0, 1500) || '')}
                {article.content && article.content.length > 1500 && '…'}
              </p>
            </div>
          )}

          {/* Tags editor */}
          <TagsEditor articleId={article.id} initialTags={article.tags} />

          {/* Unified timeline */}
          <div className="space-y-2.5">
            {timeline.length === 0 && (
              <p className="text-xs text-slate-500 italic text-center py-3">
                Ask a question, or analyze the article with a focus aspect.
              </p>
            )}
            {timeline.map(it => {
              if (it.kind === 'user') {
                return (
                  <div key={it.id} className="ml-auto max-w-[88%] bg-indigo-600/20 text-indigo-100 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {it.content}
                  </div>
                )
              }
              if (it.kind === 'assistant') {
                return (
                  <div key={it.id} className="max-w-[92%] bg-[#252836] text-slate-200 rounded-lg px-3 py-2 break-words">
                    <MessageContent content={it.content} />
                  </div>
                )
              }
              if (it.kind === 'analysis') {
                return <AnalysisItem key={it.id} a={it.analysis} />
              }
              if (it.kind === 'pending-chat') {
                return (
                  <div key={it.id} className="bg-[#252836] rounded-lg px-3 py-2 text-sm text-slate-400 w-20 animate-pulse">
                    answering…
                  </div>
                )
              }
              if (it.kind === 'pending-summarize') {
                return (
                  <div key={it.id} className="bg-[#0a0f1e] rounded-lg px-3 py-2 text-sm text-slate-400 flex items-center gap-2 border border-emerald-500/30">
                    <Loader2 size={12} className="animate-spin text-emerald-400" />
                    Summarizing…
                  </div>
                )
              }
              if (it.kind === 'pending-factcheck') {
                return (
                  <div key={it.id} className="bg-[#0a0f1e] rounded-lg px-3 py-2 text-sm text-slate-400 flex items-center gap-2 border border-sky-500/30">
                    <Loader2 size={12} className="animate-spin text-sky-400" />
                    Fact-checking against live web sources…
                  </div>
                )
              }
              return (
                <div key={it.id} className="bg-[#0a0f1e] rounded-lg px-3 py-2 text-sm text-slate-400 flex items-center gap-2 border border-indigo-500/30">
                  <Loader2 size={12} className="animate-spin text-indigo-400" />
                  Analyzing{it.focus ? ` "${it.focus.slice(0, 60)}"` : ''}…
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-[#1e2433] p-4 bg-[#0a0f1e] space-y-2.5">

          {/* Controls — collapsible aspect presets toggle + language */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPresetsOpen(o => !o)}
              className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-white transition-colors"
              title={presetsOpen ? 'Hide quick aspects' : 'Show quick aspects'}
            >
              {presetsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Quick aspects
            </button>
            <div className="flex-1 min-w-0" />
            <Globe size={13} className="text-slate-500 flex-shrink-0" />
            <select
              value={language}
              onChange={e => setLanguage(e.target.value as Lang)}
              className="bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/40 rounded-lg px-1.5 sm:px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer flex-shrink-0"
            >
              {LANGUAGES.map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          {/* Aspect preset chips — collapsed by default */}
          {presetsOpen && (
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_PRESETS.map(p => (
                <button
                  key={p}
                  onClick={() => setInput(p)}
                  disabled={busy}
                  className="text-[10px] px-2 py-0.5 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/40 text-slate-400 hover:text-white rounded-full transition-colors disabled:opacity-40"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send('ask') }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send('analyze') }
            }}
            rows={1}
            placeholder="Ask a question or describe a focus aspect…"
            className="w-full bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none max-h-32 leading-relaxed"
            style={{ minHeight: 38 }}
          />

          {/* All action buttons — one row under the input */}
          <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto">
            <button
              onClick={() => send('summarize')}
              disabled={busy}
              title="One-click article summary"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs text-white font-semibold transition-colors whitespace-nowrap flex-shrink-0"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
              Summarize
            </button>
            <button
              onClick={() => send('factcheck')}
              disabled={busy}
              title="Fact-check this article's claims against live web sources"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded-lg text-xs text-white font-semibold transition-colors whitespace-nowrap flex-shrink-0"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              Fact Check
            </button>
            <button
              onClick={() => send('ask')}
              disabled={busy || !input.trim()}
              title="Ask (Enter) — quick chat answer"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg text-xs text-white font-medium transition-colors whitespace-nowrap flex-shrink-0"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Ask
            </button>
            <button
              onClick={() => send('analyze')}
              disabled={busy || !input.trim()}
              title="Analyze (⌘/Ctrl+Enter) — save a structured analysis"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-xs text-white font-medium transition-colors whitespace-nowrap flex-shrink-0"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Analyze
            </button>
          </div>

          <p className="text-[10px] text-slate-600">
            <span className="text-emerald-400">Summarize</span> = one-click summary ·{' '}
            <span className="text-sky-400">Fact Check</span> = verify claims via web ·{' '}
            <span className="text-amber-400">Ask</span> = chat answer ·{' '}
            <span className="text-indigo-400">Analyze</span> = saved structured report ·{' '}
            Enter = Ask · ⌘/Ctrl+Enter = Analyze
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function AnalysisItem({ a }: { a: Analysis }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {a.impact_type && <ImpactBadge type={a.impact_type} />}
          {a.focus && (
            <span className="text-[10px] px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full">{a.focus}</span>
          )}
          {a.model_used && <span className="text-[10px] text-slate-600">{a.model_used}</span>}
          <span className="text-[10px] text-slate-600">{fmtDate(a.created_at)}</span>
        </div>
        <ChevronDown size={14} className={clsx('text-slate-500 flex-shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2 text-sm text-slate-300">
          {a.summary && <Section label="Summary" text={a.summary} />}
          {a.economic_impact && <Section label="Economic Impact" text={a.economic_impact} />}
          {a.market_analysis && <Section label="Market Analysis" text={a.market_analysis} />}
          {a.geopolitical_factors && <Section label="Geopolitical" text={a.geopolitical_factors} />}
          {a.risk_assessment && <Section label="Risks" text={a.risk_assessment} />}
          {a.opportunities && <Section label="Opportunities" text={a.opportunities} />}
          <div className="grid grid-cols-2 gap-2">
            {a.prognosis_short && <Section label="Short-term (1–6mo)" text={a.prognosis_short} accent="text-indigo-400" />}
            {a.prognosis_long && <Section label="Long-term (6–24mo)" text={a.prognosis_long} accent="text-pink-400" />}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, text, accent }: { label: string; text: string; accent?: string }) {
  return (
    <div>
      <p className={clsx('text-[10px] font-bold uppercase tracking-wider mb-1', accent || 'text-slate-500')}>{label}</p>
      <p className="text-sm text-slate-300 leading-relaxed">{text}</p>
    </div>
  )
}
