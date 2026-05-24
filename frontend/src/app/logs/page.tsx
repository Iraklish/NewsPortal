'use client'

import { useEffect, useRef, useState } from 'react'
import { logsApi, type LogListResponse, type LogSettings } from '@/lib/api'
import { FileText, RefreshCw, Trash2, Save, Loader2, Search, X } from 'lucide-react'
import clsx from 'clsx'

type Source = 'app' | 'client'
type Level = '' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

const LEVELS_FOR_FILTER: Level[] = ['', 'DEBUG', 'INFO', 'WARNING', 'ERROR']

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function lineColor(line: string): string {
  if (/\bERROR\b|\bCRITICAL\b/.test(line)) return 'text-red-400'
  if (/\bWARN(ING)?\b/.test(line)) return 'text-amber-400'
  if (/\bDEBUG\b/.test(line)) return 'text-slate-500'
  return 'text-slate-300'
}

export default function LogsPage() {
  const [source, setSource] = useState<Source>('app')
  const [limit, setLimit] = useState(500)
  const [level, setLevel] = useState<Level>('')
  const [q, setQ] = useState('')
  const [data, setData] = useState<LogListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [settings, setSettings] = useState<LogSettings | null>(null)
  const [retentionInput, setRetentionInput] = useState('24')
  const [levelInput, setLevelInput] = useState('INFO')
  const [savingSettings, setSavingSettings] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await logsApi.list({ source, limit, level: level || undefined, q: q || undefined })
      setData(res)
    } finally {
      setLoading(false)
    }
  }

  async function loadSettings() {
    try {
      const s = await logsApi.getSettings()
      setSettings(s)
      setRetentionInput(String(s.log_retention_hours))
      setLevelInput(s.log_level)
    } catch {}
  }

  useEffect(() => { loadSettings() }, [])

  useEffect(() => {
    load()
  }, [source, limit, level, q]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [autoRefresh, source, limit, level, q]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Scroll to bottom when new lines arrive
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [data])

  async function saveSettings() {
    setSavingSettings(true)
    setSavedMsg('')
    try {
      const updated = await logsApi.updateSettings({
        log_retention_hours: parseInt(retentionInput) || 24,
        log_level: levelInput,
      })
      setSettings(updated)
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(''), 3000)
    } catch (e: unknown) {
      setSavedMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSavingSettings(false)
    }
  }

  async function clearLog() {
    if (!confirm(`Truncate ${source}.log? Older rotated files are kept.`)) return
    try {
      await logsApi.clear(source)
      load()
    } catch (e: unknown) {
      alert('Failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <FileText size={20} className="text-indigo-400" />
            Logs
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Backend (Python) and frontend (browser-captured) logs, rotated hourly.
          </p>
        </div>
      </div>

      {/* Settings */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 mb-4 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
        <label className="block">
          <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Retention (hours)</span>
          <input
            type="number"
            min={1}
            max={2160}
            value={retentionInput}
            onChange={e => setRetentionInput(e.target.value)}
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Log level</span>
          <select
            value={levelInput}
            onChange={e => setLevelInput(e.target.value)}
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
          >
            {['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <button
          onClick={saveSettings}
          disabled={savingSettings}
          className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-sm text-white font-medium"
        >
          {savingSettings ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        <div className="text-xs text-slate-500 text-right">
          {savedMsg && <span className="text-emerald-400">{savedMsg}</span>}
          {settings && !savedMsg && (
            <>active: {settings.log_retention_hours}h · {settings.log_level}</>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-3 mb-3 flex items-center gap-2 flex-wrap">
        <div className="flex bg-[#0a0f1e] border border-[#1e2433] rounded-lg p-0.5">
          {(['app', 'client'] as Source[]).map(s => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={clsx(
                'px-3 py-1 text-xs rounded transition-colors',
                source === s ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              )}
            >
              {s === 'app' ? 'Backend' : 'Frontend'}
            </button>
          ))}
        </div>
        <select
          value={level}
          onChange={e => setLevel(e.target.value as Level)}
          className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-xs text-slate-300"
        >
          {LEVELS_FOR_FILTER.map(l => <option key={l} value={l}>{l || 'All levels'}</option>)}
        </select>
        <select
          value={limit}
          onChange={e => setLimit(parseInt(e.target.value))}
          className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-xs text-slate-300"
        >
          {[100, 250, 500, 1000, 2500, 5000].map(n => <option key={n} value={n}>last {n}</option>)}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Filter…"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded pl-7 pr-7 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
          />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
              <X size={10} />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
            className="cursor-pointer accent-indigo-500"
          />
          Auto-refresh
        </label>
        <button
          onClick={load}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={clearLog}
          className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-red-400 hover:bg-red-500/5 rounded"
          title={`Truncate ${source}.log`}
        >
          <Trash2 size={11} /> Clear
        </button>
      </div>

      {/* Log viewer */}
      <div className="bg-[#0a0f1e] border border-[#1e2433] rounded-xl overflow-hidden">
        <div
          ref={scrollRef}
          className="h-[calc(100vh-380px)] min-h-[400px] overflow-auto p-3 font-mono text-[11px] leading-relaxed"
        >
          {loading && !data ? (
            <p className="text-slate-500">Loading…</p>
          ) : !data || data.lines.length === 0 ? (
            <p className="text-slate-500">
              No entries{q || level ? ' match the current filters' : ' yet'}.
            </p>
          ) : (
            data.lines.map((ln, i) => (
              <div key={i} className={clsx('whitespace-pre-wrap break-all', lineColor(ln))}>
                {ln}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-[#1e2433] px-3 py-1.5 flex items-center justify-between text-[10px] text-slate-500">
          <span>{data?.path}</span>
          <span>
            {data ? `${data.count} line${data.count === 1 ? '' : 's'} shown` : ''}
            {data ? ` · file: ${fmtSize(data.size_bytes)}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
