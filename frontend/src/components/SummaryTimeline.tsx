'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Activity, ChevronDown, ChevronRight, RefreshCw, AlertTriangle,
  X, ExternalLink, Globe, Hash, Clock, Search,
} from 'lucide-react'
import { analysisApi, TimelineResponse, TimelineArticle } from '@/lib/api'

const GRANULARITIES = [
  { value: 'auto',  label: 'Auto' }, { value: '1min',  label: '1m' },  { value: '5min',  label: '5m' },
  { value: '10min', label: '10m' },  { value: '15min', label: '15m' }, { value: '30min', label: '30m' },
  { value: '45min', label: '45m' },  { value: 'hour',  label: '1h' },  { value: '3hour', label: '3h' },
  { value: '6hour', label: '6h' },   { value: 'day',   label: '1d' },  { value: 'week',  label: '1w' },
]

interface Props {
  filterType: 'tag' | 'category' | 'keyword'
  filterValue: string
  timeWindow: number
  maxArticles: number
}

interface Selection { bucket: number; country: string | null; topic: string | null }

function fmtTime(iso: string, bucketSeconds: number): string {
  const d = new Date(iso)
  if (bucketSeconds >= 86400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtShort(iso: string, bucketSeconds: number): string {
  const d = new Date(iso)
  if (bucketSeconds >= 86400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function SummaryTimeline({ filterType, filterValue, timeWindow, maxArticles }: Props) {
  const [open, setOpen]        = useState(false)
  const [granularity, setGran] = useState('auto')
  const [loading, setLoading]  = useState(false)
  const [error, setError]      = useState<string | null>(null)
  const [data, setData]        = useState<TimelineResponse | null>(null)

  // adjustable filters
  const [country, setCountry]   = useState<string | null>(null)
  const [topic, setTopic]       = useState<string | null>(null)
  const [textInput, setTextInput] = useState('')
  const [q, setQ]               = useState('')

  // drill-down
  const [selection, setSelection]       = useState<Selection | null>(null)
  const [drill, setDrill]               = useState<TimelineArticle[] | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError]     = useState<string | null>(null)

  // debounce free-text → q
  useEffect(() => {
    const t = setTimeout(() => setQ(textInput.trim()), 400)
    return () => clearTimeout(t)
  }, [textInput])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await analysisApi.timeline({
        filter_type: filterType, filter_value: filterValue,
        time_window_hours: timeWindow, max_articles: maxArticles,
        granularity, country, topic, q,
      })
      setData(res); setSelection(null); setDrill(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load timeline')
    } finally { setLoading(false) }
  }, [filterType, filterValue, timeWindow, maxArticles, granularity, country, topic, q])

  useEffect(() => { if (open) load() }, [open, load])
  // reset adjustable filters when the parent summary scope changes
  useEffect(() => { setCountry(null); setTopic(null); setTextInput(''); setQ(''); setSelection(null); setDrill(null) },
    [filterType, filterValue, timeWindow, maxArticles])

  const barValues = useMemo<number[]>(() => data ? data.buckets.map(b => b.count) : [], [data])
  const metricMax = useMemo(() => Math.max(1, ...barValues), [barValues])

  const drillInto = useCallback(async (bucket: number, override: { country?: string | null; topic?: string | null }) => {
    if (!data) return
    const c = override.country !== undefined ? override.country : country
    const t = override.topic !== undefined ? override.topic : topic
    setSelection({ bucket, country: c, topic: t })
    setDrillLoading(true); setDrillError(null); setDrill(null)
    const startISO = data.buckets[bucket].start
    const endMs = Date.parse(startISO) + data.bucket_seconds * 1000
    try {
      const res = await analysisApi.timelineArticles({
        filter_type: filterType, filter_value: filterValue,
        start: startISO, end: new Date(endMs).toISOString(),
        country: c, topic: t, q, limit: 100,
      })
      setDrill(res.articles)
    } catch (e: unknown) {
      setDrillError(e instanceof Error ? e.message : 'Failed to load articles')
    } finally { setDrillLoading(false) }
  }, [data, filterType, filterValue, country, topic, q])

  const clearSelection = () => { setSelection(null); setDrill(null); setDrillError(null) }

  const nBuckets = data?.buckets.length ?? 0
  const labelEvery = nBuckets > 0 ? Math.max(1, Math.ceil(nBuckets / 6)) : 1
  const selBucket = selection?.bucket ?? null
  const noEntitySel = !!selection && !selection.country && !selection.topic

  const selectCls = 'bg-[#161b22] border border-[#1e2433] rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-indigo-500/50 max-w-[150px]'

  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-2xl overflow-hidden">
      {/* Header */}
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full px-5 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
        title={open ? 'Collapse' : 'Expand'}>
        {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
        <Activity size={14} className="text-indigo-400" />
        <h2 className="text-xs text-slate-300 font-semibold uppercase tracking-wider">Timeline &amp; Heatmap</h2>
        {data && (
          <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded-full leading-none">{data.total}</span>
        )}
        <span className="text-[10px] text-slate-600 ml-1 hidden sm:inline">countries · topics · filterable</span>
        {open && (
          <span role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); if (!loading) load() }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (!loading) load() } }}
            className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors" title="Refresh">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </span>
        )}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-[#1e2433] pt-4">
          {/* Adjust: Time · Country · Topic · Free text */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-600 uppercase tracking-wider mr-1 flex items-center gap-1"><Clock size={10} /> Time</span>
              {GRANULARITIES.map(({ value, label }) => (
                <button key={value} onClick={() => setGran(value)}
                  className={['px-2 py-1 rounded-lg text-[11px] font-medium transition-colors',
                    granularity === value ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 border border-[#1e2433] hover:text-white hover:border-slate-600'].join(' ')}>
                  {label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-600 uppercase tracking-wider flex items-center gap-1"><Globe size={10} /> Country</span>
              <select className={selectCls} value={country ?? ''} onChange={e => setCountry(e.target.value || null)}>
                <option value="">All</option>
                {(data?.all_countries ?? []).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-600 uppercase tracking-wider flex items-center gap-1"><Hash size={10} /> Topic</span>
              <select className={selectCls} value={topic ?? ''} onChange={e => setTopic(e.target.value || null)}>
                <option value="">All</option>
                {(data?.all_topics ?? []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>

            <label className="flex items-center gap-1.5 flex-1 min-w-[160px]">
              <span className="text-[10px] text-slate-600 uppercase tracking-wider flex items-center gap-1"><Search size={10} /> Text</span>
              <div className="relative flex-1">
                <input value={textInput} onChange={e => setTextInput(e.target.value)} placeholder="free text…"
                  className="w-full bg-[#161b22] border border-[#1e2433] rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50" />
                {textInput && (
                  <button onClick={() => setTextInput('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-600 hover:text-white" title="Clear">
                    <X size={12} />
                  </button>
                )}
              </div>
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
              <AlertTriangle size={13} /> {error}
            </div>
          )}
          {loading && !data && (
            <div className="flex items-center gap-2 text-xs text-slate-500 py-8 justify-center">
              <RefreshCw size={14} className="animate-spin" /> Building timeline…
            </div>
          )}
          {data && data.total === 0 && !loading && (
            <div className="text-xs text-slate-600 italic py-6 text-center">No articles match these filters.</div>
          )}

          {data && data.total > 0 && (
            <>
              {/* Volume bar chart */}
              <div>
                <div className="flex items-end gap-px h-28">
                  {data.buckets.map((b, i) => {
                    const v = barValues[i] ?? 0
                    const f = v / metricMax
                    const isSel = selBucket === i
                    return (
                      <button key={i} onClick={() => drillInto(i, {})}
                        className={['flex-1 min-w-[2px] rounded-t-sm transition-all cursor-pointer hover:brightness-125',
                          isSel ? 'outline outline-2 outline-white/70 z-10' : 'hover:outline hover:outline-1 hover:outline-white/30'].join(' ')}
                        style={{ height: `${Math.max(v > 0 ? 6 : 0, f * 100)}%`, backgroundColor: `rgba(99,102,241,${0.25 + 0.75 * f})` }}
                        title={`${fmtTime(b.start, data.bucket_seconds)}\nArticles: ${b.count}\n\nClick to list articles`} />
                    )
                  })}
                </div>
                <div className="flex mt-1.5">
                  {data.buckets.map((b, i) => (
                    <div key={i} className="flex-1 min-w-[2px] text-center overflow-visible">
                      {i % labelEvery === 0 && <span className="text-[9px] text-slate-600 whitespace-nowrap">{fmtShort(b.start, data.bucket_seconds)}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Country & topic heatmap */}
              <div className="space-y-1 overflow-x-auto">
                {data.rows.map((row, r) => {
                  const prev = data.rows[r - 1]
                  const groupBreak = r > 0 && prev.kind !== row.kind
                  const isCountry = row.kind === 'country'
                  const activeLabel = isCountry ? country : topic
                  const selMatches = noEntitySel || (isCountry ? selection?.country === row.label : selection?.topic === row.label)
                  return (
                    <div key={`${row.kind}:${row.label}`}>
                      {(r === 0 || groupBreak) && (
                        <div className="flex items-center gap-1.5 mt-2 mb-1 pl-1">
                          {isCountry ? <Globe size={10} className="text-slate-500" /> : <Hash size={10} className="text-slate-500" />}
                          <span className="text-[9px] uppercase tracking-wider text-slate-600">{isCountry ? 'Countries' : 'Topics'}</span>
                        </div>
                      )}
                      <HeatRow label={row.label} labelClass="text-slate-400"
                        values={data.matrix[r]} max={data.max_cell}
                        color={(f) => `rgba(99,102,241,${0.06 + 0.94 * f})`}
                        selectedBucket={selBucket} selectedMatches={!!selMatches}
                        active={activeLabel === row.label}
                        onLabel={() => isCountry
                          ? setCountry(cur => cur === row.label ? null : row.label)
                          : setTopic(cur => cur === row.label ? null : row.label)}
                        onCell={(i) => drillInto(i, isCountry ? { country: row.label } : { topic: row.label })}
                        tip={(i) => `${row.label} · ${fmtTime(data.buckets[i].start, data.bucket_seconds)}\nArticles: ${data.matrix[r][i]}\n\nClick to list articles`} />
                    </div>
                  )
                })}
              </div>

              {/* Legend + drivers */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                <span className="text-[10px] text-slate-600">
                  {nBuckets} buckets · {Math.round(data.bucket_seconds / 60)}min each · click a row to filter
                </span>
                {data.top_terms.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 uppercase tracking-wider">Drivers</span>
                    {data.top_terms.slice(0, 8).map(t => (
                      <span key={t.term} className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/10 text-indigo-300/90 border border-indigo-500/20">
                        {t.term} <span className="text-indigo-400/60">{t.count}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Drill-down */}
              {selection && (
                <div className="border border-[#1e2433] rounded-xl bg-[#0b0e14] mt-1">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1e2433]">
                    <Activity size={13} className="text-indigo-400" />
                    <span className="text-xs text-slate-300">
                      {fmtTime(data.buckets[selection.bucket].start, data.bucket_seconds)}
                      {selection.country && <span className="text-indigo-400"> · {selection.country}</span>}
                      {selection.topic && <span className="text-indigo-400"> · {selection.topic}</span>}
                      {drill && <span className="text-slate-500"> · {drill.length} article{drill.length === 1 ? '' : 's'}</span>}
                    </span>
                    <button onClick={clearSelection} className="ml-auto p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors" title="Close">
                      <X size={13} />
                    </button>
                  </div>
                  <div className="max-h-[340px] overflow-y-auto">
                    {drillLoading && (
                      <div className="flex items-center gap-2 text-xs text-slate-500 py-6 justify-center">
                        <RefreshCw size={13} className="animate-spin" /> Loading articles…
                      </div>
                    )}
                    {drillError && <div className="px-4 py-3 text-xs text-red-400">{drillError}</div>}
                    {drill && drill.length === 0 && !drillLoading && (
                      <div className="px-4 py-5 text-xs text-slate-600 italic text-center">No articles in this slot.</div>
                    )}
                    {drill && drill.map(a => (
                      <div key={a.id} className="flex items-start gap-2.5 px-4 py-2 border-b border-[#161b22] last:border-0 hover:bg-white/[0.02]">
                        <div className="min-w-0 flex-1">
                          {a.url && a.url.startsWith('http') ? (
                            <a href={a.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-white hover:text-indigo-400 transition-colors flex items-center gap-1.5 group">
                              <span className="line-clamp-1">{a.title || a.url}</span>
                              <ExternalLink size={9} className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                            </a>
                          ) : (
                            <span className="text-xs text-white line-clamp-1">{a.title || '(no title)'}</span>
                          )}
                          <div className="flex items-center gap-2 mt-0.5">
                            {a.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#161b22] text-slate-500 border border-[#1e2433]">{a.category}</span>}
                            {a.source && <span className="text-[10px] text-slate-500">{a.source}</span>}
                            {a.published_at && (
                              <span className="text-[10px] text-slate-600">
                                {new Date(a.published_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Heatmap row ────────────────────────────────────────────────────────────────

function HeatRow({
  label, labelClass, values, max, color, selectedBucket, selectedMatches, active, onLabel, onCell, tip,
}: {
  label: string
  labelClass: string
  values: number[]
  max: number
  color: (frac: number) => string
  selectedBucket: number | null
  selectedMatches?: boolean
  active?: boolean
  onLabel?: () => void
  onCell: (bucketIndex: number) => void
  tip: (bucketIndex: number) => string
}) {
  const safeMax = Math.max(1, max)
  const highlight = selectedMatches === undefined ? true : selectedMatches
  return (
    <div className="flex items-center gap-2">
      {onLabel ? (
        <button onClick={onLabel} title={`Filter: ${label}`}
          className={['w-24 shrink-0 text-[10px] truncate text-right transition-colors hover:text-white',
            active ? 'text-indigo-300 font-semibold' : labelClass].join(' ')}>
          {label}
        </button>
      ) : (
        <span className={`w-24 shrink-0 text-[10px] truncate text-right ${labelClass}`} title={label}>{label}</span>
      )}
      <div className="flex gap-px flex-1 min-w-[280px]">
        {values.map((v, i) => {
          const isSel = selectedBucket === i && highlight
          return (
            <button key={i} onClick={() => onCell(i)}
              className={['flex-1 h-4 rounded-[2px] min-w-[3px] cursor-pointer hover:brightness-150 transition-all',
                isSel ? 'outline outline-2 outline-white/70 z-10' : ''].join(' ')}
              style={{ backgroundColor: v > 0 ? color(v / safeMax) : 'rgba(255,255,255,0.025)' }}
              title={tip(i)} />
          )
        })}
      </div>
    </div>
  )
}
