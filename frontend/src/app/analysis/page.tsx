'use client'

import { useEffect, useState } from 'react'
import { analysisApi, articlesApi, type DirectedReport } from '@/lib/api'
import ImpactBadge from '@/components/ImpactBadge'
import {
  Sparkles, Loader2, ExternalLink, Trash2, AlertCircle, Globe, Database,
  TrendingUp, TrendingDown, Zap, ChevronRight, RefreshCw, Search,
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
]

export default function AnalysisPage() {
  const [focus, setFocus] = useState('')
  const [includeWeb, setIncludeWeb] = useState(false)
  const [timeWindowHours, setTimeWindowHours] = useState(24)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState<DirectedReport | null>(null)
  const [reports, setReports] = useState<DirectedReport[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [trendingTopics, setTrendingTopics] = useState<string[]>([])
  const [loadingTopics, setLoadingTopics] = useState(true)

  async function loadHistory() {
    try {
      const data = await analysisApi.listReports()
      setReports(data)
    } finally {
      setLoadingHistory(false)
    }
  }

  useEffect(() => {
    loadHistory()
    articlesApi.trendingTopics({ limit: 20, hours: 72 })
      .then(r => setTrendingTopics(r.topics))
      .catch(() => {})
      .finally(() => setLoadingTopics(false))
  }, [])

  // Debounced preview of matching DB articles for current focus + window
  useEffect(() => {
    const f = focus.trim()
    if (!f) { setPreviewCount(null); return }
    setPreviewLoading(true)
    const handle = setTimeout(() => {
      analysisApi.previewDirected(f, timeWindowHours)
        .then(r => setPreviewCount(r.db_article_count))
        .catch(() => setPreviewCount(null))
        .finally(() => setPreviewLoading(false))
    }, 400)
    return () => clearTimeout(handle)
  }, [focus, timeWindowHours])

  async function runReport() {
    if (!focus.trim()) return
    setRunning(true)
    setError('')
    setCurrent(null)
    try {
      const report = await analysisApi.runDirectedReport({
        focus: focus.trim(),
        include_web: includeWeb,
        time_window_hours: timeWindowHours,
      })
      setCurrent(report)
      loadHistory()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  async function deleteReport(id: number) {
    if (!confirm('Delete this report?')) return
    try {
      await analysisApi.deleteReport(id)
      if (current?.id === id) setCurrent(null)
      loadHistory()
    } catch {}
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

        <div className="flex flex-wrap gap-1.5 mt-2 min-h-[22px]">
          {loadingTopics ? (
            <span className="text-[10px] text-slate-600 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> Loading trending topics…
            </span>
          ) : trendingTopics.length > 0 ? (
            trendingTopics.map(p => (
              <button
                key={p}
                onClick={() => setFocus(p)}
                className="text-[10px] px-2 py-0.5 bg-[#0a0f1e] border border-[#1e2433] hover:border-indigo-500/40 text-slate-400 hover:text-white rounded-full transition-colors"
              >
                {p}
              </button>
            ))
          ) : (
            <span className="text-[10px] text-slate-600 italic">No trending topics yet — fetch some news first.</span>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
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
        </div>

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#1e2433]">
          <div className="flex items-center gap-3 text-[11px]">
            {focus.trim() ? (
              previewLoading ? (
                <span className="text-slate-500 flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" /> counting…
                </span>
              ) : previewCount != null ? (
                <span className="flex items-center gap-1.5 text-slate-400">
                  <Database size={11} className="text-indigo-400" />
                  <span className="text-white font-semibold">{previewCount}</span>
                  matching article{previewCount === 1 ? '' : 's'} in window
                </span>
              ) : (
                <span className="text-slate-600">⌘/Ctrl+Enter to run</span>
              )
            ) : (
              <span className="text-slate-600">⌘/Ctrl+Enter to run</span>
            )}
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

      {current && <ReportCard report={current} onDelete={() => deleteReport(current.id)} expanded />}

      {/* History */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Previous Reports</h2>
          <button onClick={loadHistory} className="text-xs text-slate-500 hover:text-white transition-colors flex items-center gap-1">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {loadingHistory ? (
          <div className="text-xs text-slate-500">Loading…</div>
        ) : reports.length === 0 ? (
          <p className="text-sm text-slate-500">No reports yet. Generate your first one above.</p>
        ) : (
          <div className="space-y-2">
            {reports.map(r => (
              <button
                key={r.id}
                onClick={() => setCurrent(r)}
                className={clsx(
                  'w-full text-left bg-[#0d1117] border rounded-xl p-3 transition-colors flex items-center gap-3',
                  current?.id === r.id
                    ? 'border-indigo-500/50 bg-indigo-500/5'
                    : 'border-[#1e2433] hover:border-[#2d3148]'
                )}
              >
                {r.impact_type && <ImpactBadge type={r.impact_type} />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{r.focus}</p>
                  <p className="text-xs text-slate-500 truncate">{r.headline || r.executive_summary?.slice(0, 120)}</p>
                </div>
                <div className="text-[10px] text-slate-600 flex items-center gap-3 flex-shrink-0">
                  <span className="flex items-center gap-1"><Database size={10} />{r.db_article_count}</span>
                  <span className="flex items-center gap-1"><Globe size={10} />{r.web_result_count}</span>
                  <span>{fmt(r.created_at)}</span>
                </div>
                <ChevronRight size={14} className="text-slate-600 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
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


function ReportCard({ report, onDelete, expanded }: { report: DirectedReport; onDelete: () => void; expanded?: boolean }) {
  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-6 mb-6">
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
        <button onClick={onDelete} className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0">
          <Trash2 size={14} />
        </button>
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
}

function Block({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className={clsx('text-xs font-bold uppercase tracking-wider mb-2', accent || 'text-slate-500')}>{title}</h3>
      {children}
    </div>
  )
}

function ImpactBlock({ icon: Icon, title, text, accent }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; text: string; accent?: string }) {
  return (
    <div className="bg-[#0a0f1e] rounded-lg p-4 border border-[#1e2433]">
      <h3 className={clsx('text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5', accent || 'text-slate-400')}>
        <Icon size={11} /> {title}
      </h3>
      <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
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
