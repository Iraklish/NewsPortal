'use client'

import { useEffect, useRef, useState } from 'react'
import { analysisApi, articlesApi, settingsApi, type DirectedReport } from '@/lib/api'
import ImpactBadge from '@/components/ImpactBadge'
import { useLanguage } from '@/lib/language'
import {
  Sparkles, Loader2, ExternalLink, Trash2, AlertCircle, Globe, Database,
  TrendingUp, TrendingDown, Zap, Search, Plus,
  MessageCircle, Send, ChevronDown, ChevronRight, ChevronUp, Maximize2, Minimize2, X,
} from 'lucide-react'
import clsx from 'clsx'

function fmt(s?: string): string {
  if (!s) return ''
  const ms = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? new Date(s).getTime() : new Date(s + 'Z').getTime()
  return new Date(ms).toLocaleString()
}



const TIME_WINDOWS: { label: string; hours: number }[] = [
  { label: 'Last 1 hour', hours: 1 },
  { label: 'Last 2 hours', hours: 2 },
  { label: 'Last 6 hours', hours: 6 },
  { label: 'Last 12 hours', hours: 12 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 2 days', hours: 48 },
  { label: 'Last 3 days', hours: 72 },
  { label: 'Last 1 week', hours: 168 },
  { label: 'Last 2 weeks', hours: 336 },
  { label: 'Last 1 month', hours: 720 },
  { label: 'Last 2 months', hours: 1440 },
  { label: 'Last 6 months', hours: 4380 },
  { label: 'Last 1 year', hours: 8760 },
  { label: 'All time', hours: 0 },
]

export default function AnalysisPage() {
  const [focus, setFocus] = useState('')
  const [aspect, setAspect] = useState('')
  const [category, setCategory] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [tag, setTag] = useState('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [includeWeb, setIncludeWeb] = useState(false)
  const [includeWebSearch, setIncludeWebSearch] = useState(false)
  const [timeWindowHours, setTimeWindowHours] = useState(2)
  const { language } = useLanguage()

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState<DirectedReport | null>(null)

  // Predefined, editable focus-topic presets (collapsed by default)
  const [focusPresets, setFocusPresets] = useState<string[]>([])
  const [showPresets, setShowPresets] = useState(false)
  const [editPresets, setEditPresets] = useState(false)
  const [newPreset, setNewPreset] = useState('')
  const [savingPresets, setSavingPresets] = useState(false)

  useEffect(() => {
    settingsApi.getAnalysisFocusPresets()
      .then(r => setFocusPresets(r.presets))
      .catch(() => {})
    articlesApi.categories()
      .then(cats => setCategories(cats))
      .catch(() => {})
    articlesApi.tags()
      .then(ts => setAllTags(ts))
      .catch(() => {})
  }, [])

  async function persistPresets(next: string[]) {
    const prev = focusPresets
    setFocusPresets(next)
    setSavingPresets(true)
    try {
      const r = await settingsApi.setAnalysisFocusPresets(next)
      setFocusPresets(r.presets)
    } catch {
      setFocusPresets(prev)
    } finally {
      setSavingPresets(false)
    }
  }

  function addPreset() {
    const t = newPreset.trim()
    if (!t || focusPresets.length >= 20 || focusPresets.some(p => p.toLowerCase() === t.toLowerCase())) {
      setNewPreset('')
      return
    }
    persistPresets([...focusPresets, t])
    setNewPreset('')
  }

  function removePreset(p: string) {
    persistPresets(focusPresets.filter(x => x !== p))
  }

  const combinedFocus = focus.trim()
    + (aspect.trim() ? ` — analyzed from the perspective of: ${aspect.trim()}` : '')

  async function runReport() {
    if (!focus.trim()) return
    setRunning(true)
    setError('')
    setCurrent(null)
    try {
      const report = await analysisApi.runDirectedReport({
        focus: combinedFocus,
        category: category || undefined,
        tag: tag || undefined,
        include_web: includeWeb,
        include_web_search: includeWebSearch,
        time_window_hours: timeWindowHours,
        language: language !== 'English' ? language : undefined,
      })
      setCurrent(report)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Sparkles size={22} className="text-indigo-400" />
          Analysis & Prognosis
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Synthesize a multi-source report combining your news database with live web search.
        </p>
      </div>

      {/* Focus input card */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-5 mb-6">
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Focus topic</label>
        <textarea
          value={focus}
          onChange={e => setFocus(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runReport()
          }}
          placeholder="e.g. Impact of Iran sanctions on global oil markets and energy security"
          rows={2}
          className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
        />

        {/* Predefined focus topics — collapsed by default, editable */}
        <div className="mt-2">
          <button
            onClick={() => setShowPresets(v => !v)}
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-white transition-colors"
            title={showPresets ? 'Hide presets' : 'Show presets'}
          >
            {showPresets ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Predefined topics
            {focusPresets.length > 0 && <span className="text-slate-600">({focusPresets.length})</span>}
          </button>

          {showPresets && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {focusPresets.map(p => (
                  <span
                    key={p}
                    className="flex items-center gap-1 bg-[#0a0f1e] border border-[#1e2433] rounded-full pl-2.5 pr-1.5 py-0.5 text-[10px] text-slate-400"
                  >
                    <button onClick={() => setFocus(p)} className="hover:text-white transition-colors text-left" title="Use this topic">
                      {p}
                    </button>
                    {editPresets && (
                      <button onClick={() => removePreset(p)} disabled={savingPresets} title="Remove" className="text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40">
                        <X size={10} />
                      </button>
                    )}
                  </span>
                ))}
                {focusPresets.length === 0 && <span className="text-[10px] text-slate-600 italic">No presets — add one below.</span>}
              </div>
              <div className="flex items-center gap-2">
                {editPresets && (
                  <>
                    <input
                      value={newPreset}
                      onChange={e => setNewPreset(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPreset() } }}
                      placeholder="New focus topic…"
                      maxLength={300}
                      className="flex-1 bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50"
                    />
                    <button
                      onClick={addPreset}
                      disabled={!newPreset.trim() || focusPresets.length >= 20 || savingPresets}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded-lg text-xs disabled:opacity-40 transition-colors"
                    >
                      {savingPresets ? <Loader2 size={11} className="animate-spin" /> : <Plus size={12} />} Add
                    </button>
                  </>
                )}
                <button onClick={() => setEditPresets(v => !v)} className="ml-auto text-[10px] text-slate-500 hover:text-white transition-colors">
                  {editPresets ? 'Done' : 'Edit'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Aspect */}
        <div className="mt-3">
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
            Aspect <span className="normal-case font-normal text-slate-600">(optional — analyze from the perspective of…)</span>
          </label>
          <input
            value={aspect}
            onChange={e => setAspect(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runReport() }}
            placeholder="e.g. Israeli economy, emerging markets, energy sector, tech stocks…"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Category</span>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">All categories</option>
              {categories.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-teal-500 uppercase tracking-wider">Topic tag</span>
            <select
              value={tag}
              onChange={e => setTag(e.target.value)}
              className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-teal-500"
            >
              <option value="">All tags</option>
              {allTags.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Time window</span>
            <select
              value={timeWindowHours}
              onChange={e => setTimeWindowHours(parseInt(e.target.value))}
              className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
            >
              {TIME_WINDOWS.map(w => (
                <option key={w.hours} value={w.hours}>{w.label}</option>
              ))}
            </select>
          </label>
          <Option
            label="Use AI web grounding"
            on={includeWeb}
            onChange={setIncludeWeb}
            hint="Lets the model search the live web (Gemini/Anthropic)"
          />
          <Option
            label="Use web search"
            on={includeWebSearch}
            onChange={setIncludeWebSearch}
            hint="Google · DuckDuckGo · Bing results injected as context"
          />
        </div>

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#1e2433]">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-slate-600">⌘/Ctrl+Enter to run</span>
          </div>
          <button
            onClick={runReport}
            disabled={running || !focus.trim()}
            className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm text-white font-semibold transition-colors"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {running ? 'Synthesizing…' : 'Generate Report'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {running && !current && (
        <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-8 mb-6 text-center">
          <Loader2 size={32} className="animate-spin text-indigo-400 mx-auto mb-3" />
          <p className="text-sm text-slate-400">Gathering sources, synthesizing…</p>
          <p className="text-xs text-slate-600 mt-1">This can take 20–60 seconds depending on model + web fetch.</p>
        </div>
      )}

      {current && (
        <ReportCard
          report={current}
          onDelete={() => { analysisApi.deleteReport(current.id).catch(() => {}); setCurrent(null) }}
          expanded
        />
      )}
    </div>
  )
}

function Option({ label, on, onChange, hint, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <label className={clsx('flex items-start gap-2 p-2 rounded-lg cursor-pointer', disabled && 'opacity-40 cursor-not-allowed')}>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 cursor-pointer accent-indigo-500"
      />
      <span>
        <span className="block text-xs text-white font-medium">{label}</span>
        {hint && <span className="block text-[10px] text-slate-600 mt-0.5">{hint}</span>}
      </span>
    </label>
  )
}


function ReportCard({ report, onDelete, expanded, onClose }: { report: DirectedReport; onDelete: () => void; expanded?: boolean; onClose?: () => void }) {
  const [chatOpen, setChatOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)

  // In modal (pop-out) mode, close on Escape.
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const inner = (
    <div className={clsx(
      'bg-[#0d1117] border border-[#1e2433]',
      maximized ? 'w-full min-h-full p-6 overflow-y-auto' : 'rounded-xl p-6 mb-6',
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-[#1e2433]">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {report.impact_type && <ImpactBadge type={report.impact_type} />}
            {report.confidence_score != null && (
              <span className="text-[10px] px-2 py-0.5 bg-slate-500/10 text-slate-400 border border-slate-500/20 rounded-full">
                {Math.round(report.confidence_score * 100)}% conf
              </span>
            )}
            {report.model_used && (
              <span className="text-[10px] text-slate-600 font-mono">{report.model_used}</span>
            )}
            <span className="text-[10px] text-slate-600 ml-auto">{fmt(report.created_at)}</span>
          </div>
          <h2 className="text-xl font-bold text-white leading-snug">{report.headline || report.focus}</h2>
          <p className="text-sm text-slate-500 mt-1">Focus: <span className="text-indigo-400">{report.focus}</span></p>
          <div className="flex items-center gap-4 mt-2 text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><Database size={11} /> {report.db_article_count} DB article{report.db_article_count !== 1 ? 's' : ''}</span>
            <span className="flex items-center gap-1"><Globe size={11} /> {report.web_result_count} web result{report.web_result_count !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setMaximized(m => !m)}
            title={maximized ? 'Restore' : 'Maximize'}
            className="p-1.5 text-slate-600 hover:text-white hover:bg-white/10 rounded transition-colors"
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button onClick={onDelete} className="p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded">
            <Trash2 size={14} />
          </button>
          {onClose && (
            <button onClick={onClose} title="Close" aria-label="Close" className="p-1.5 text-slate-600 hover:text-white hover:bg-white/10 transition-colors rounded">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Executive summary */}
      {report.executive_summary && (
        <Block title="Executive Summary" accent="text-indigo-400">
          <p className="text-sm text-slate-200 leading-relaxed">{report.executive_summary}</p>
        </Block>
      )}

      {/* Key developments */}
      {report.key_developments.length > 0 && (
        <Block title="Key Developments" accent="text-amber-400">
          <ul className="space-y-1.5">
            {report.key_developments.map((d, i) => (
              <li key={i} className="text-sm text-slate-300 leading-relaxed flex gap-2">
                <span className="text-amber-400 mt-0.5">•</span>
                <span>{renderWithCitations(d, report.references)}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {/* Impacts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {report.economic_impact && <ImpactBlock icon={TrendingUp} title="Economic Impact" text={report.economic_impact} />}
        {report.market_impact && <ImpactBlock icon={TrendingDown} title="Market Impact" text={report.market_impact} />}
        {report.geopolitical_impact && <ImpactBlock icon={Globe} title="Geopolitical Impact" text={report.geopolitical_impact} />}
        {report.risk_assessment && <ImpactBlock icon={AlertCircle} title="Risks" text={report.risk_assessment} accent="text-red-400" />}
      </div>

      {/* Sector impact */}
      {report.sector_impact && Object.keys(report.sector_impact).length > 0 && (
        <Block title="Sector Impact" accent="text-cyan-400">
          <div className="space-y-1.5">
            {Object.entries(report.sector_impact).map(([sector, impact]) => (
              <div key={sector} className="text-sm">
                <span className="text-cyan-400 font-semibold">{sector}:</span>{' '}
                <span className="text-slate-300">{impact}</span>
              </div>
            ))}
          </div>
        </Block>
      )}

      {/* Opportunities & contrarian */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {report.opportunities && <ImpactBlock icon={Sparkles} title="Opportunities" text={report.opportunities} accent="text-emerald-400" />}
        {report.contrarian_views && <ImpactBlock icon={Zap} title="Contrarian View" text={report.contrarian_views} accent="text-purple-400" />}
      </div>

      {/* Prognosis */}
      {(report.prognosis_short || report.prognosis_long) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {report.prognosis_short && (
            <div className="bg-[#0a0f1e] rounded-lg p-4 border border-indigo-500/30">
              <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2">Short-term (1–6 mo)</p>
              <p className="text-sm text-slate-200 leading-relaxed">{report.prognosis_short}</p>
            </div>
          )}
          {report.prognosis_long && (
            <div className="bg-[#0a0f1e] rounded-lg p-4 border border-pink-500/30">
              <p className="text-xs font-bold text-pink-400 uppercase tracking-wider mb-2">Long-term (6–24 mo)</p>
              <p className="text-sm text-slate-200 leading-relaxed">{report.prognosis_long}</p>
            </div>
          )}
        </div>
      )}

      {/* Signals to watch */}
      {report.signals_to_watch.length > 0 && (
        <Block title="Signals to Watch" accent="text-yellow-400">
          <ul className="space-y-1">
            {report.signals_to_watch.map((s, i) => (
              <li key={i} className="text-sm text-slate-300 flex gap-2">
                <Search size={12} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {/* Follow-up chat */}
      <div className="mt-4 pt-4 border-t border-[#1e2433]">
        <button
          onClick={() => setChatOpen(v => !v)}
          className="flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors"
        >
          <MessageCircle size={13} className="text-indigo-400" />
          Follow-up questions
          {chatOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {chatOpen && <ReportChat reportId={report.id} />}
      </div>

      {/* References */}
      {report.references.length > 0 && (
        <Block title={`References (${report.references.length})`} accent="text-slate-400">
          <div className="space-y-1.5">
            {report.references.map((ref, i) => {
              const tag = ref.kind === 'db' ? `DB-${i + 1}` : `WEB-${i + 1 - report.db_article_count}`
              return (
                <a
                  key={i}
                  href={ref.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-[#0a0f1e] rounded-lg p-3 border border-[#1e2433] hover:border-indigo-500/30 transition-colors group"
                >
                  <div className="flex items-start gap-3">
                    <span className={clsx(
                      'text-[10px] px-1.5 py-0.5 rounded font-mono mt-0.5 flex-shrink-0',
                      ref.kind === 'db'
                        ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30'
                        : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    )}>
                      {tag}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium leading-snug group-hover:text-indigo-300 transition-colors">
                        {ref.title || ref.url}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2">
                        <span>{ref.source}</span>
                        {ref.published_at && <span>· {ref.published_at.slice(0, 10)}</span>}
                      </p>
                      {ref.snippet && (
                        <p className="text-xs text-slate-400 mt-1 line-clamp-2">{ref.snippet}</p>
                      )}
                    </div>
                    <ExternalLink size={12} className="text-slate-600 group-hover:text-indigo-400 transition-colors flex-shrink-0 mt-1" />
                  </div>
                </a>
              )
            })}
          </div>
        </Block>
      )}
    </div>
  )

  // Pop-out (modal) mode: backdrop click closes; maximize toggles full-bleed.
  if (onClose) {
    return (
      <div
        className={clsx('fixed inset-0 z-50 bg-black/80 overflow-y-auto flex items-start justify-center', maximized ? 'p-0' : 'p-4 md:p-8')}
        onClick={onClose}
      >
        <div
          onClick={e => e.stopPropagation()}
          className={clsx(maximized ? 'w-full min-h-screen' : 'w-full max-w-4xl my-auto')}
        >
          {inner}
        </div>
      </div>
    )
  }

  return maximized ? (
    <div className="fixed inset-0 z-50 bg-black/80 overflow-y-auto" onClick={() => setMaximized(false)}>
      <div onClick={e => e.stopPropagation()}>{inner}</div>
    </div>
  ) : inner
}

function Block({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className={clsx('text-xs font-bold uppercase tracking-wider mb-2', accent || 'text-slate-500')}>{title}</h3>
      {children}
    </div>
  )
}

function ImpactBlock({ icon: Icon, title, text, accent }: { icon: React.ComponentType<{ size?: number | string; className?: string }>; title: string; text: string; accent?: string }) {
  return (
    <div className="bg-[#0a0f1e] rounded-lg p-4 border border-[#1e2433]">
      <h3 className={clsx('text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5', accent || 'text-slate-400')}>
        <Icon size={11} /> {title}
      </h3>
      <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
    </div>
  )
}

// ── Follow-up chat for a single report ───────────────────────────────────────

type ChatMsg = { role: 'user' | 'assistant'; content: string }

function ReportChat({ reportId }: { reportId: number }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [asking, setAsking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const q = input.trim()
    if (!q || asking) return
    const newMsg: ChatMsg = { role: 'user', content: q }
    const updated = [...messages, newMsg]
    setMessages(updated)
    setInput('')
    setAsking(true)
    try {
      const res = await analysisApi.askReport(reportId, q, updated.slice(-12))
      setMessages(prev => [...prev, { role: 'assistant', content: res.response }])
    } catch (e: unknown) {
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="mt-3 bg-[#0a0f1e] rounded-lg border border-[#1e2433] overflow-hidden">
      {messages.length > 0 && (
        <div className="max-h-72 overflow-y-auto p-3 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={clsx('flex gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              {m.role === 'assistant' && (
                <div className="w-5 h-5 rounded-full bg-indigo-600/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Sparkles size={10} className="text-indigo-400" />
                </div>
              )}
              <div className={clsx(
                'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
                m.role === 'user'
                  ? 'bg-indigo-600/20 text-indigo-100 border border-indigo-500/20'
                  : 'bg-[#0d1117] text-slate-200 border border-[#1e2433]',
              )}>
                {m.content}
              </div>
            </div>
          ))}
          {asking && (
            <div className="flex gap-2">
              <div className="w-5 h-5 rounded-full bg-indigo-600/30 flex items-center justify-center flex-shrink-0">
                <Loader2 size={10} className="text-indigo-400 animate-spin" />
              </div>
              <div className="bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-xs text-slate-500">
                Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
      <div className="flex items-center gap-2 p-2 border-t border-[#1e2433]">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask a follow-up question about this report…"
          className="flex-1 bg-transparent text-xs text-white placeholder-slate-600 focus:outline-none px-2 py-1.5"
          disabled={asking}
        />
        <button
          onClick={send}
          disabled={asking || !input.trim()}
          className="p-1.5 text-indigo-400 hover:text-indigo-300 disabled:opacity-30 transition-colors"
        >
          {asking ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  )
}


// Render text with [DB-N] / [WEB-N] markers as clickable chips
function renderWithCitations(text: string, refs: { url?: string }[]): React.ReactNode {
  const parts = text.split(/(\[(?:DB|WEB)-\d+\])/g)
  return parts.map((part, i) => {
    const m = part.match(/^\[(DB|WEB)-(\d+)\]$/)
    if (m) {
      const isDb = m[1] === 'DB'
      const idx = parseInt(m[2]) - 1
      // For WEB-N, offset by db count; figure out the actual ref index
      // Refs are stored DB-first then WEB. For DB-1 → 0, WEB-1 → first web after db block
      // Caller has the indices laid out correctly already; we just need to find a URL if exists
      const url = refs[idx]?.url
      const chipClass = isDb
        ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/20'
        : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
      return url ? (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className={clsx('inline-block text-[10px] px-1.5 py-0 mx-0.5 rounded font-mono border transition-colors', chipClass)}>
          {part}
        </a>
      ) : (
        <span key={i} className={clsx('inline-block text-[10px] px-1.5 py-0 mx-0.5 rounded font-mono border', chipClass)}>
          {part}
        </span>
      )
    }
    return <span key={i}>{part}</span>
  })
}
