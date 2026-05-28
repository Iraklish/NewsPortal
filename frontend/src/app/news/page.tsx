'use client'

import { useEffect, useRef, useState } from 'react'
import {
  articlesApi,
  analysisApi,
  sourcesApi,
  type Article,
  type Analysis,
} from '@/lib/api'
import ImpactBadge from '@/components/ImpactBadge'
import MessageContent from '@/components/MessageContent'
import {
  RefreshCw, Search, X, ExternalLink, Loader2, Sparkles,
  Send, ChevronDown, Clock, Plus, BookOpen, Globe, Maximize2, Minimize2,
  CheckSquare, Square, Tag, LayoutGrid, Rows3,
} from 'lucide-react'
import clsx from 'clsx'
import AddArticleModal from '@/components/AddArticleModal'

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

  // Grid / limit settings — persisted to localStorage
  const [gridCols, setGridColsRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return 2
    const v = parseInt(localStorage.getItem('news_grid_cols') || '2', 10)
    return [1, 2, 3, 4].includes(v) ? v : 2
  })
  const [gridRows, setGridRowsRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return 10
    const v = parseInt(localStorage.getItem('news_grid_rows') || '10', 10)
    return [5, 10, 20, 50].includes(v) ? v : 10
  })

  function setGridCols(n: number) {
    setGridColsRaw(n)
    if (typeof window !== 'undefined') localStorage.setItem('news_grid_cols', String(n))
    load({ limit: n * gridRows })
  }

  function setGridRows(n: number) {
    setGridRowsRaw(n)
    if (typeof window !== 'undefined') localStorage.setItem('news_grid_rows', String(n))
    load({ limit: gridCols * n })
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function reloadTags() {
    articlesApi.tags().then(setAllTags).catch(() => {})
  }

  async function loadStatus() {
    try { setStatus(await sourcesApi.status()) } catch {}
  }

  async function load(params?: { category?: string; q?: string; tag?: string; limit?: number }) {
    setLoading(true)
    const effCategory = params?.category ?? category
    const effQuery = params?.q ?? query
    const effTag = params?.tag !== undefined ? params.tag : tag
    const effLimit = params?.limit ?? (gridCols * gridRows)
    try {
      const [data, countRes] = await Promise.all([
        articlesApi.list({ limit: effLimit, category: effCategory, q: effQuery, tag: effTag }),
        articlesApi.count({ category: effCategory, q: effQuery, tag: effTag }),
      ])
      setArticles(data)
      setTotalCount(countRes.count)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    articlesApi.categories().then(setCategories).catch(() => {})
    reloadTags()
    load()
    loadStatus()
    const id = setInterval(loadStatus, 30000)  // refresh every 30s
    return () => clearInterval(id)
  }, [])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load({ q: query }), 350)
  }, [query])

  function pickCategory(c: string) {
    setCategory(c)
    load({ category: c, q: query, tag })
  }

  function pickTag(t: string) {
    setTag(t)
    load({ tag: t, category, q: query })
  }

  async function refreshFeeds() {
    setRefreshing(true)
    setRefreshMsg('')
    try {
      const res = await articlesApi.fetchAll()
      setRefreshMsg(`Fetched ${res.fetched} new articles`)
      await load()
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
                {totalCount.toLocaleString()}{(category || query) ? ' matching' : ' total'}
              </span>
            )}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Live feed from {categories.length || 6} categories
            {totalCount != null && articles.length < totalCount && (
              <> · showing {articles.length} of {totalCount.toLocaleString()}</>
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
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search title, summary, or content…"
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
          value={tag}
          onChange={e => pickTag(e.target.value)}
          className="bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-teal-500"
          title="Filter by topic tag"
        >
          <option value="">All Tags</option>
          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
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
          = {gridCols * gridRows} per load
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
            onClick={bulkAutoTagSelected}
            disabled={bulkTagging}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600/20 hover:bg-teal-600/40 disabled:opacity-50 border border-teal-500/30 rounded text-xs text-teal-300 font-medium transition-colors flex-shrink-0"
          >
            {bulkTagging ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            Auto-tag selected
          </button>
        </div>
      )}
      {!selectedIds.size && bulkTagMsg && (
        <p className="text-xs text-teal-400 mb-3">{bulkTagMsg}</p>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-24 bg-[#0d1117] border border-[#1e2433] rounded-xl animate-pulse" />
          ))}
        </div>
      ) : articles.length === 0 ? (
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
            src={article.image_url}
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
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold text-teal-500 uppercase tracking-wider flex-1">Topic Tags</span>
        <button
          onClick={autoTag}
          disabled={autoTagging}
          title="Auto-extract English tags using AI (works for any language)"
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 bg-teal-500/10 text-teal-400 border border-teal-500/20 rounded hover:bg-teal-500/20 transition-colors disabled:opacity-50"
        >
          {autoTagging ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
          Auto-tag
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[22px]">
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

function ArticleDetail({ article, onClose }: { article: Article; onClose: () => void }) {
  // Unified timeline of user prompts, AI chat replies, and persisted analyses,
  // sorted chronologically (oldest first → newest at the bottom, chat-style).
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [language, setLanguage] = useState<Lang>('English')
  const [maximized, setMaximized] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

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

  async function send(mode: 'ask' | 'analyze' | 'summarize') {
    const langSuffix = LANG_INSTRUCTION[language]
    const SUMMARIZE_PROMPT =
      'Please provide a concise summary of this article. Cover: the main topic, key facts or figures, who is involved, why it matters, and any immediate implications.' + langSuffix
    const rawText = mode === 'summarize' ? SUMMARIZE_PROMPT : input.trim()
    // For ask/analyze, append language instruction to the effective prompt but keep the display label clean
    const text = (mode !== 'summarize' && langSuffix) ? rawText + langSuffix : rawText
    if (!text || busy) return
    setBusy(true)
    setError('')
    const now = Date.now()
    const pendingId = `p-${now}`

    if (mode === 'summarize') {
      setTimeline(prev => [...prev, { kind: 'pending-summarize', id: pendingId, at: now }])
    } else {
      const userItem: TimelineItem = { kind: 'user', id: `u-${now}`, at: now, content: rawText }
      const pending: TimelineItem = mode === 'ask'
        ? { kind: 'pending-chat', id: pendingId, at: now + 1 }
        : { kind: 'pending-analyze', id: pendingId, at: now + 1, focus: rawText }
      setTimeline(prev => [...prev, userItem, pending])
      setInput('')
    }

    try {
      if (mode === 'ask' || mode === 'summarize') {
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
            <h2 className="text-lg font-bold text-white leading-snug">{article.title}</h2>
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

          {/* Row 1 — Summarize (prominent) + Language */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => send('summarize')}
              disabled={busy}
              title="One-click article summary"
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-sm text-white font-semibold transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <BookOpen size={14} />}
              Summarize
            </button>
            <div className="flex-1" />
            <Globe size={13} className="text-slate-500 flex-shrink-0" />
            <select
              value={language}
              onChange={e => setLanguage(e.target.value as Lang)}
              className="bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/40 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
            >
              {LANGUAGES.map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          {/* Row 2 — Aspect preset chips */}
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

          {/* Row 3 — Textarea + Ask + Analyze */}
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send('ask') }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send('analyze') }
              }}
              rows={1}
              placeholder="Ask a question or describe a focus aspect…"
              className="flex-1 bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none max-h-32 leading-relaxed"
              style={{ minHeight: 38 }}
            />
            <button
              onClick={() => send('ask')}
              disabled={busy || !input.trim()}
              title="Ask (Enter) — quick chat answer"
              className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg text-sm text-white font-medium transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Ask
            </button>
            <button
              onClick={() => send('analyze')}
              disabled={busy || !input.trim()}
              title="Analyze (⌘/Ctrl+Enter) — save a structured analysis"
              className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm text-white font-medium transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Analyze
            </button>
          </div>

          <p className="text-[10px] text-slate-600">
            <span className="text-emerald-400">Summarize</span> = one-click summary ·{' '}
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
