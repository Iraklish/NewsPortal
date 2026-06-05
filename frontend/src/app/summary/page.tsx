'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ScrollText, Tag, Layers, Search, Sparkles, RefreshCw,
  ChevronRight, Clock, FileText, ExternalLink,
  ChevronDown, MessageSquare, Send, User, Bot, SlidersHorizontal, Filter, Maximize2, Minimize2, Plus, X,
} from 'lucide-react'
import { analysisApi, articlesApi, settingsApi, SummaryResponse } from '@/lib/api'
import SummaryMarkdown from '@/components/SummaryMarkdown'
import MessageContent from '@/components/MessageContent'
import SummaryViewerModal from '@/components/SummaryViewerModal'
import { useLanguage } from '@/lib/language'

// ── types ─────────────────────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

// ── constants ─────────────────────────────────────────────────────────────────

const FILTER_TYPES = [
  { value: 'tag'      as const, label: 'By Tag',      icon: Tag,    placeholder: 'e.g. markets' },
  { value: 'category' as const, label: 'By Category', icon: Layers, placeholder: 'e.g. economics' },
  { value: 'keyword'  as const, label: 'By Keyword',  icon: Search, placeholder: 'e.g. inflation' },
]

const TIME_WINDOWS = [
  { label: '1h',  value: 1   },
  { label: '2h',  value: 2   },
  { label: '6h',  value: 6   },
  { label: '24h', value: 24  },
  { label: '48h', value: 48  },
  { label: '7d',  value: 168 },
  { label: '30d', value: 720 },
]

const MAX_ARTICLES_OPTIONS = [
  { label: '50',   value: 50   },
  { label: '100',  value: 100  },
  { label: '200',  value: 200  },
  { label: '500',  value: 500  },
  { label: '1000', value: 1000 },
  { label: 'All',  value: 0    },
]

// ── helpers ───────────────────────────────────────────────────────────────────

function PillBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
        active
          ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
          : 'text-slate-400 border border-[#1e2433] hover:text-white hover:border-slate-600',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function AccordionToggle({
  open, onToggle, icon: Icon, label, badge,
}: {
  open: boolean
  onToggle: () => void
  icon: React.ComponentType<{ size?: number | string; className?: string }>
  label: string
  badge?: string
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors w-full text-left"
    >
      <Icon size={13} className="shrink-0" />
      <span>{label}</span>
      {badge && (
        <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20">
          {badge}
        </span>
      )}
      <ChevronDown
        size={12}
        className={['ml-auto transition-transform duration-200 shrink-0', open ? 'rotate-180' : ''].join(' ')}
      />
    </button>
  )
}

// ── component ─────────────────────────────────────────────────────────────────

export default function SummaryPage() {
  // primary controls
  const [timeWindow, setTimeWindow]   = useState(6)
  const [maxArticles, setMaxArticles] = useState(0)   // 0 = All
  const { language }                  = useLanguage()

  // optional filter (collapsed by default)
  const [showFilter, setShowFilter]   = useState(false)
  const [filterType, setFilterType]   = useState<'tag' | 'category' | 'keyword'>('keyword')
  const [filterValue, setFilterValue] = useState('')

  // optional custom prompt (collapsed by default)
  const [showPrompt, setShowPrompt]   = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')

  // predefined editable extra-instruction presets (collapsed by default)
  const [showPresets, setShowPresets] = useState(false)
  const [presets, setPresets]         = useState<string[]>([])
  const [editPresets, setEditPresets] = useState(false)
  const [newPreset, setNewPreset]     = useState('')
  const [savingPresets, setSavingPresets] = useState(false)

  // generation
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [result, setResult]           = useState<SummaryResponse | null>(null)
  const [viewerOpen, setViewerOpen]   = useState(false)

  // autocomplete
  const [categories, setCategories]   = useState<string[]>([])
  const [tags, setTags]               = useState<string[]>([])

  // chat
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput]       = useState('')
  const [chatLoading, setChatLoading]   = useState(false)
  const [chatOpen, setChatOpen]         = useState(false)   // collapsed by default
  const [chatMaximized, setChatMaximized] = useState(false)
  const chatEndRef                      = useRef<HTMLDivElement>(null)

  useEffect(() => {
    articlesApi.categories().then(c => setCategories(c.sort())).catch(() => {})
    articlesApi.tags().then(t => setTags(t.sort())).catch(() => {})
    settingsApi.getSummaryPresets().then(r => setPresets(r.presets)).catch(() => {})
  }, [])

  async function persistPresets(next: string[]) {
    const prev = presets
    setPresets(next)
    setSavingPresets(true)
    try {
      const r = await settingsApi.setSummaryPresets(next)
      setPresets(r.presets)
    } catch {
      setPresets(prev)
    } finally {
      setSavingPresets(false)
    }
  }

  function applyPreset(p: string) {
    setShowPrompt(true)
    setCustomPrompt(cur => {
      const t = cur.trim()
      return t ? `${t}\n${p}` : p
    })
  }

  function addPreset() {
    const t = newPreset.trim()
    if (!t || presets.length >= 20 || presets.some(p => p.toLowerCase() === t.toLowerCase())) {
      setNewPreset('')
      return
    }
    persistPresets([...presets, t])
    setNewPreset('')
  }

  function removePreset(p: string) {
    persistPresets(presets.filter(x => x !== p))
  }

  useEffect(() => { setFilterValue('') }, [filterType])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatLoading])

  useEffect(() => {
    if (!chatMaximized) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatMaximized(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatMaximized])

  const suggestions: string[] =
    filterType === 'category' ? categories :
    filterType === 'tag'      ? tags        :
    []

  const filteredSuggestions = filterValue
    ? suggestions.filter(s => s.toLowerCase().includes(filterValue.toLowerCase())).slice(0, 10)
    : suggestions.slice(0, 10)

  // ── generate ─────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    setChatMessages([])
    try {
      const res = await analysisApi.summarize({
        filter_type: filterType,
        filter_value: showFilter ? filterValue.trim() : '',
        time_window_hours: timeWindow,
        max_articles: maxArticles,
        custom_prompt: customPrompt.trim() || undefined,
        language: language !== 'English' ? language : undefined,
      })
      setResult(res)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Summary generation failed')
    } finally {
      setLoading(false)
    }
  }, [filterType, filterValue, showFilter, timeWindow, maxArticles, customPrompt, language])

  // ── chat ─────────────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || chatLoading || !result) return
    const question = chatInput.trim()
    setChatInput('')
    const outgoing: ChatMsg[] = [...chatMessages, { role: 'user', content: question }]
    setChatMessages(outgoing)
    setChatLoading(true)
    try {
      const res = await analysisApi.summarizeAsk({
        summary: result.summary,
        question,
        history: chatMessages,
      })
      setChatMessages([...outgoing, { role: 'assistant', content: res.response }])
    } catch (e: unknown) {
      setChatMessages([...outgoing, {
        role: 'assistant',
        content: '⚠ ' + (e instanceof Error ? e.message : 'Request failed'),
      }])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, result, chatMessages])

  const currentType = FILTER_TYPES.find(f => f.value === filterType)!
  const activeFilter = showFilter && filterValue.trim()

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-indigo-600/20 rounded-xl border border-indigo-500/30">
          <ScrollText size={20} className="text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Article Summary</h1>
          <p className="text-sm text-slate-500">
            AI summary of recent articles — pick a window and generate
          </p>
        </div>
      </div>

      {/* ── Controls card ────────────────────────────────────────────────── */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-2xl p-5 space-y-5">

        {/* ── Primary: time window + max articles ── */}
        <div className="flex flex-wrap gap-6">
          <div>
            <label className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2 flex items-center gap-1">
              <Clock size={11} /> Time window
            </label>
            <div className="flex gap-1.5 flex-wrap">
              {TIME_WINDOWS.map(({ label, value }) => (
                <PillBtn key={value} active={timeWindow === value} onClick={() => setTimeWindow(value)}>
                  {label}
                </PillBtn>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2 block">
              Max articles
            </label>
            <div className="flex gap-1.5 flex-wrap">
              {MAX_ARTICLES_OPTIONS.map(({ label, value }) => (
                <PillBtn key={value} active={maxArticles === value} onClick={() => setMaxArticles(value)}>
                  {label}
                </PillBtn>
              ))}
            </div>
          </div>

        </div>

        {/* ── Divider ── */}
        <div className="border-t border-[#1e2433]" />

        {/* ── Optional: filter ── */}
        <div className="space-y-3">
          <AccordionToggle
            open={showFilter}
            onToggle={() => setShowFilter(v => !v)}
            icon={Filter}
            label="Filter by tag / category / keyword"
            badge={activeFilter ? filterValue.trim() : undefined}
          />

          {showFilter && (
            <div className="space-y-3 pl-1">
              {/* Filter type pills */}
              <div className="flex gap-2 flex-wrap">
                {FILTER_TYPES.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => setFilterType(value)}
                    className={[
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      filterType === value
                        ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                        : 'text-slate-400 border border-[#1e2433] hover:text-white hover:border-slate-600',
                    ].join(' ')}
                  >
                    <Icon size={12} />
                    {label}
                  </button>
                ))}
              </div>

              {/* Value input */}
              <input
                type="text"
                value={filterValue}
                onChange={e => setFilterValue(e.target.value)}
                placeholder={currentType.placeholder}
                onKeyDown={e => e.key === 'Enter' && !loading && generate()}
                className="w-full px-4 py-2.5 bg-[#161b22] border border-[#1e2433] rounded-xl text-white text-sm
                           placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
              />

              {/* Suggestion chips */}
              {(filterType === 'tag' || filterType === 'category') && filteredSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {filteredSuggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => setFilterValue(s)}
                      className={[
                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                        filterValue === s
                          ? 'bg-indigo-600/30 text-indigo-400 border border-indigo-500/40'
                          : 'bg-[#161b22] text-slate-400 border border-[#1e2433] hover:text-white hover:border-slate-600',
                      ].join(' ')}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Predefined instructions (collapsed by default, editable) ── */}
        <div className="space-y-3">
          <AccordionToggle
            open={showPresets}
            onToggle={() => setShowPresets(v => !v)}
            icon={Sparkles}
            label="Predefined instructions"
            badge={presets.length ? String(presets.length) : undefined}
          />

          {showPresets && (
            <div className="space-y-2 pl-1">
              <p className="text-[10px] text-slate-600">
                Click to add to Extra instructions. Edit the list below (up to 20).
              </p>
              <div className="flex flex-wrap gap-1.5">
                {presets.map(p => (
                  <span
                    key={p}
                    className="flex items-center gap-1 bg-[#161b22] border border-[#1e2433] rounded-full pl-3 pr-1.5 py-1 text-xs text-slate-300"
                  >
                    <button onClick={() => applyPreset(p)} className="hover:text-indigo-300 transition-colors" title="Add to Extra instructions">
                      {p}
                    </button>
                    {editPresets && (
                      <button onClick={() => removePreset(p)} disabled={savingPresets} title="Remove" className="text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40">
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
                {presets.length === 0 && <span className="text-xs text-slate-600 italic">No presets — add one below.</span>}
              </div>
              <div className="flex items-center gap-2">
                {editPresets && (
                  <>
                    <input
                      value={newPreset}
                      onChange={e => setNewPreset(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPreset() } }}
                      placeholder="New instruction…"
                      maxLength={200}
                      className="flex-1 bg-[#161b22] border border-[#1e2433] rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50"
                    />
                    <button
                      onClick={addPreset}
                      disabled={!newPreset.trim() || presets.length >= 20 || savingPresets}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded-lg text-xs disabled:opacity-40 transition-colors"
                    >
                      {savingPresets ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={12} />} Add
                    </button>
                  </>
                )}
                <button
                  onClick={() => setEditPresets(v => !v)}
                  className="ml-auto text-[11px] text-slate-500 hover:text-white transition-colors"
                >
                  {editPresets ? 'Done' : 'Edit'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Optional: custom prompt ── */}
        <div className="space-y-3">
          <AccordionToggle
            open={showPrompt}
            onToggle={() => setShowPrompt(v => !v)}
            icon={SlidersHorizontal}
            label="Extra instructions"
            badge={customPrompt.trim() ? 'active' : undefined}
          />

          {showPrompt && (
            <div className="space-y-1.5 pl-1">
              <textarea
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                placeholder={'Added on top of the base prompt — use to focus, filter or adjust tone.\n\nExamples:\n• Focus on Marvel / entertainment news\n• Group results by region\n• Respond in Hebrew\n• Highlight any market-moving events'}
                rows={4}
                className="w-full px-4 py-3 bg-[#161b22] border border-[#1e2433] rounded-xl text-white text-xs
                           font-mono placeholder-slate-600 focus:outline-none focus:border-indigo-500/50
                           transition-colors resize-y leading-relaxed"
              />
              {customPrompt.trim() && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-amber-400/80">
                    Appended to base prompt — use for focus, tone, or structure
                  </span>
                  <button
                    onClick={() => setCustomPrompt('')}
                    className="text-[10px] text-slate-500 hover:text-white transition-colors"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Generate button ── */}
        <button
          onClick={generate}
          disabled={loading}
          className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium
                     rounded-xl transition-colors"
        >
          {loading
            ? <RefreshCw size={14} className="animate-spin" />
            : <Sparkles size={14} />
          }
          {loading ? 'Generating…' : 'Generate Summary'}
        </button>
      </div>

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm">
          <span className="text-red-400 flex-1">{error}</span>
          <button
            onClick={generate}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {result && (
        <div className="space-y-4">

          {/* Meta row */}
          <div className="flex items-center gap-3 px-4 py-3 bg-[#0d1117] border border-[#1e2433] rounded-xl">
            <FileText size={14} className="text-indigo-400 shrink-0" />
            <span className="text-sm text-slate-300">
              Summary of{' '}
              <span className="text-white font-medium">{result.article_count}</span> articles
              {result.filter_value && result.filter_type !== 'all' && (
                <>
                  {' · '}{result.filter_type}:{' '}
                  <span className="text-indigo-400 font-medium">{result.filter_value}</span>
                </>
              )}
              {language !== 'English' && (
                <span className="text-slate-500"> · {language}</span>
              )}
              {result.time_span && (
                <span className="text-slate-500"> · {result.time_span}</span>
              )}
            </span>
          </div>

          {/* Summary text */}
          <div className="bg-[#0d1117] border border-[#1e2433] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs text-slate-500 uppercase tracking-wider font-medium">Summary</h2>
              <button
                onClick={() => setViewerOpen(true)}
                title="Pop out — enlarge & search"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-indigo-300 bg-indigo-600/15 border border-indigo-500/30 hover:bg-indigo-600/30 transition-colors"
              >
                <Maximize2 size={12} /> Pop out
              </button>
            </div>
            <SummaryMarkdown content={result.summary} />
          </div>

          {/* ── Follow-up Chat (collapsible / maximizable) ─────────────── */}
          {chatMaximized && <div className="fixed inset-0 z-[60] bg-black/70" onClick={() => setChatMaximized(false)} />}
          <div className={`bg-[#0d1117] border border-[#1e2433] overflow-hidden flex flex-col ${chatMaximized ? 'fixed inset-0 sm:inset-6 z-[60] rounded-none sm:rounded-2xl shadow-2xl' : 'rounded-2xl'}`}>
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#1e2433]">
              <button
                onClick={() => setChatOpen(v => !v)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                title={chatOpen ? 'Collapse' : 'Expand'}
              >
                {(chatOpen || chatMaximized) ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                <MessageSquare size={14} className="text-indigo-400" />
                <h2 className="text-xs text-slate-300 font-semibold uppercase tracking-wider">Follow-up Chat</h2>
                {chatMessages.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded-full leading-none">{chatMessages.length}</span>
                )}
                <span className="text-[10px] text-slate-600 ml-1 hidden sm:inline">drill down into any topic</span>
              </button>
              <button
                onClick={() => { setChatMaximized(v => !v); setChatOpen(true) }}
                title={chatMaximized ? 'Restore' : 'Pop out / enlarge'}
                aria-label={chatMaximized ? 'Restore chat' : 'Pop out chat'}
                className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
              >
                {chatMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              {chatMaximized && (
                <button
                  onClick={() => setChatMaximized(false)}
                  title="Close"
                  aria-label="Close chat"
                  className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {(chatOpen || chatMaximized) && (
            <>
            {/* Messages */}
            <div className={`px-5 py-4 space-y-4 overflow-y-auto ${chatMaximized ? 'flex-1' : 'max-h-[480px]'}`}>
              {chatMessages.length === 0 && (
                <div className="text-center py-6">
                  <MessageSquare size={28} className="text-slate-700 mx-auto mb-2" />
                  <p className="text-xs text-slate-600">
                    Ask a follow-up question about the summary above.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2 mt-4">
                    {[
                      'What are the most important points?',
                      'Summarize the key risks',
                      'What should I watch next?',
                    ].map(q => (
                      <button
                        key={q}
                        onClick={() => setChatInput(q)}
                        className="px-3 py-1.5 rounded-full text-xs text-slate-400 border border-[#1e2433]
                                   hover:text-white hover:border-slate-600 transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={['flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start'].join(' ')}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot size={12} className="text-indigo-400" />
                    </div>
                  )}
                  {msg.role === 'user' ? (
                    <div className="max-w-[82%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed
                                    bg-indigo-600/20 text-white border border-indigo-500/20 whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="max-w-[82%] px-4 py-3 rounded-2xl rounded-bl-md
                                    bg-[#161b22] border border-[#1e2433]">
                      <MessageContent content={msg.content} />
                    </div>
                  )}
                  {msg.role === 'user' && (
                    <div className="w-6 h-6 rounded-full bg-slate-700/50 border border-slate-600/40 flex items-center justify-center shrink-0 mt-0.5">
                      <User size={12} className="text-slate-400" />
                    </div>
                  )}
                </div>
              ))}

              {chatLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot size={12} className="text-indigo-400" />
                  </div>
                  <div className="px-4 py-3 bg-[#161b22] border border-[#1e2433] rounded-2xl rounded-bl-md flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Input row */}
            <div className="px-4 pb-4">
              <div className="flex gap-2 items-end bg-[#161b22] border border-[#1e2433] rounded-xl
                              focus-within:border-indigo-500/50 transition-colors p-1 pl-4">
                <textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      sendChat()
                    }
                  }}
                  placeholder="Ask a follow-up… (Enter to send, Shift+Enter for newline)"
                  rows={1}
                  className="flex-1 bg-transparent text-white text-sm placeholder-slate-600 resize-none
                             focus:outline-none py-2 leading-relaxed min-h-[36px] max-h-[120px]"
                  style={{ fieldSizing: 'content' } as React.CSSProperties}
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim() || chatLoading}
                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-600
                             hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed
                             text-white transition-colors shrink-0"
                >
                  {chatLoading
                    ? <RefreshCw size={14} className="animate-spin" />
                    : <Send size={14} />
                  }
                </button>
              </div>
            </div>
            </>
            )}
          </div>

          {/* Key themes */}
          {result.key_themes.length > 0 && (
            <div className="bg-[#0d1117] border border-[#1e2433] rounded-2xl p-5">
              <h2 className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-3">Key Themes</h2>
              <div className="flex flex-wrap gap-2">
                {result.key_themes.map((theme, i) => (
                  <span
                    key={i}
                    className="px-3 py-1.5 bg-indigo-600/15 text-indigo-300 border border-indigo-500/20
                               rounded-full text-xs font-medium"
                  >
                    {theme}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Source articles */}
          {result.sources.length > 0 && (
            <div className="bg-[#0d1117] border border-[#1e2433] rounded-2xl p-5">
              <h2 className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-3">
                Source Articles ({result.sources.length})
              </h2>
              <div>
                {result.sources.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 py-2.5 border-b border-[#1e2433] last:border-0"
                  >
                    <ChevronRight size={12} className="text-slate-600 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      {s.url && s.url.startsWith('http') ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-white hover:text-indigo-400 transition-colors flex items-center gap-1.5 group"
                        >
                          <span className="line-clamp-1">{s.title || s.url}</span>
                          <ExternalLink size={10} className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                        </a>
                      ) : (
                        <span className="text-sm text-white line-clamp-1">{s.title || s.url}</span>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        {s.source && <span className="text-xs text-slate-500">{s.source}</span>}
                        {s.published_at && (
                          <span className="text-xs text-slate-600">
                            {new Date(s.published_at).toLocaleDateString(undefined, {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {viewerOpen && result && (
        <SummaryViewerModal
          title={`Summary of ${result.article_count} article${result.article_count === 1 ? '' : 's'}`}
          content={result.summary}
          themes={result.key_themes}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  )
}
