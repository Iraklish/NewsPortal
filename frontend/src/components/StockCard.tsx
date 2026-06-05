'use client'
import { useEffect, useRef, useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { stocksApi, type StockAnalysis } from '@/lib/api'
import ImpactBadge from './ImpactBadge'
import { MessageCircle, Send, Sparkles, Loader2, ChevronDown, ChevronUp, Maximize2, Minimize2, ExternalLink } from 'lucide-react'
import clsx from 'clsx'

function formatLargeNum(n: number | undefined): string {
  if (n === undefined || n === null) return '—'
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

function formatVol(n: unknown): string {
  const num = Number(n)
  if (isNaN(num)) return '—'
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`
  return String(num)
}

function MetricItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-[#0a0f1e] rounded-lg p-3 border border-[#1e2433]">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-sm font-semibold text-white">{value ?? '—'}</div>
    </div>
  )
}

export default function StockCard({ analysis }: { analysis: StockAnalysis }) {
  const [chatOpen, setChatOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const isPositive = (analysis.change_pct ?? 0) >= 0
  const chartColor = isPositive ? '#10b981' : '#ef4444'
  const chartData = (analysis.price_history ?? []).slice(-30).map(p => ({
    date: p.date,
    close: p.close,
  }))

  const snap = analysis.quote_snapshot || {}
  const fiftyTwoHigh = snap['52WeekHigh'] ?? snap['high52Week'] ?? snap['fiftyTwoWeekHigh']
  const fiftyTwoLow = snap['52WeekLow'] ?? snap['low52Week'] ?? snap['fiftyTwoWeekLow']
  const volume = snap['volume'] ?? snap['Volume'] ?? snap['regularMarketVolume']
  const pe = snap['PE'] ?? snap['peRatio'] ?? snap['trailingPE'] ?? snap['forwardPE']

  const inner = (
    <div className={clsx('rounded-xl border border-[#1e2433] bg-[#0d1117] p-6 space-y-5', maximized && 'rounded-none min-h-full')}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-white">{analysis.ticker}</h2>
            {analysis.impact_type && <ImpactBadge type={analysis.impact_type} />}
          </div>
          {analysis.company_name && (
            <p className="text-slate-400 text-sm mt-0.5">{analysis.company_name}</p>
          )}
          <p className="text-xs text-slate-600 mt-1">
            {new Date(analysis.created_at.endsWith('Z') ? analysis.created_at : analysis.created_at + 'Z').toLocaleString()}
          </p>
        </div>
        <div className="flex items-start gap-2">
          <div className="text-right">
            {analysis.price !== undefined && (
              <div className="text-3xl font-bold text-white">
                ${analysis.price.toFixed(2)}
              </div>
            )}
            {analysis.change_pct !== undefined && (
              <div
                className={`text-sm font-semibold mt-0.5 ${
                  isPositive ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {isPositive ? '+' : ''}
                {analysis.change_pct.toFixed(2)}%
              </div>
            )}
          </div>
          <button
            onClick={() => setMaximized(m => !m)}
            title={maximized ? 'Restore' : 'Maximize'}
            className="p-1.5 text-slate-600 hover:text-white hover:bg-white/10 rounded transition-colors"
          >
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      {/* Sparkline */}
      {chartData.length > 0 && (
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`grad-${analysis.ticker}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" hide />
              <YAxis domain={['auto', 'auto']} hide />
              <Tooltip
                contentStyle={{
                  background: '#1a1d27',
                  border: '1px solid #2d3148',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: '#94a3b8' }}
                itemStyle={{ color: chartColor }}
                formatter={(v: number) => [`$${v.toFixed(2)}`, 'Close']}
              />
              <Area
                type="monotone"
                dataKey="close"
                stroke={chartColor}
                strokeWidth={2}
                fill={`url(#grad-${analysis.ticker})`}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MetricItem label="Market Cap" value={formatLargeNum(analysis.market_cap)} />
        <MetricItem label="Sector" value={analysis.sector} />
        <MetricItem label="Risk Level" value={analysis.risk_level} />
        <MetricItem
          label="Confidence"
          value={
            analysis.confidence_score !== undefined
              ? `${Math.round(analysis.confidence_score * 100)}%`
              : undefined
          }
        />
        <MetricItem
          label="52W High"
          value={fiftyTwoHigh ? `$${Number(fiftyTwoHigh).toFixed(2)}` : undefined}
        />
        <MetricItem
          label="52W Low"
          value={fiftyTwoLow ? `$${Number(fiftyTwoLow).toFixed(2)}` : undefined}
        />
        <MetricItem label="Volume" value={formatVol(volume)} />
        <MetricItem label="P/E Ratio" value={pe ? Number(pe).toFixed(2) : undefined} />
      </div>

      {/* Key levels */}
      {Object.keys(analysis.key_levels || {}).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Key Levels
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(analysis.key_levels).map(([label, price]) => (
              <span
                key={label}
                className="text-xs px-2.5 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
              >
                {label}: ${Number(price).toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Summary */}
      {analysis.summary && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Summary
          </p>
          <p className="text-sm text-slate-300 leading-relaxed">{analysis.summary}</p>
        </div>
      )}

      {/* Technical summary */}
      {analysis.technical_summary && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Technical Analysis
          </p>
          <p className="text-sm text-slate-300 leading-relaxed">{analysis.technical_summary}</p>
        </div>
      )}

      {/* News impact */}
      {analysis.news_impact && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            News Impact
          </p>
          <p className="text-sm text-slate-300 leading-relaxed">{analysis.news_impact}</p>
        </div>
      )}

      {/* Catalysts */}
      {(analysis.catalysts ?? []).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Catalysts
          </p>
          <ul className="space-y-1">
            {analysis.catalysts.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-indigo-400 mt-0.5">•</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Prognosis */}
      {(analysis.prognosis_short || analysis.prognosis_long) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {analysis.prognosis_short && (
            <div className="bg-[#0a0f1e] rounded-lg p-4 border border-[#1e2433]">
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2">
                Short-Term Prognosis
              </p>
              <p className="text-sm text-slate-300">{analysis.prognosis_short}</p>
            </div>
          )}
          {analysis.prognosis_long && (
            <div className="bg-[#0a0f1e] rounded-lg p-4 border border-[#1e2433]">
              <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-2">
                Long-Term Prognosis
              </p>
              <p className="text-sm text-slate-300">{analysis.prognosis_long}</p>
            </div>
          )}
        </div>
      )}

      {/* References / sources */}
      {(analysis.references ?? []).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            References ({analysis.references!.length})
          </p>
          <div className="space-y-1.5">
            {analysis.references!.map((ref, i) => (
              <a
                key={i}
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 text-xs text-slate-400 hover:text-indigo-300 transition-colors group"
              >
                <ExternalLink size={11} className="mt-0.5 flex-shrink-0 opacity-60 group-hover:opacity-100" />
                <span className="min-w-0">
                  <span className="text-slate-300 group-hover:text-indigo-300">{ref.title || ref.url}</span>
                  {ref.source && <span className="text-slate-600 ml-1.5">· {ref.source}</span>}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Follow-up chat */}
      <div className="pt-4 border-t border-[#1e2433]">
        <button
          onClick={() => setChatOpen(v => !v)}
          className="flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors"
        >
          <MessageCircle size={13} className="text-indigo-400" />
          Follow-up questions
          {chatOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {chatOpen && <StockChat ticker={analysis.ticker} />}
      </div>
    </div>
  )

  return maximized ? (
    <div className="fixed inset-0 z-50 bg-black/80 overflow-y-auto" onClick={() => setMaximized(false)}>
      <div onClick={e => e.stopPropagation()}>{inner}</div>
    </div>
  ) : inner
}

// ── Inline follow-up chat ─────────────────────────────────────────────────────

type ChatMsg = { role: 'user' | 'assistant'; content: string }

function StockChat({ ticker }: { ticker: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [asking, setAsking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

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
      const res = await stocksApi.ask(ticker, q, updated.slice(-12))
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
            <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="w-5 h-5 rounded-full bg-indigo-600/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Sparkles size={10} className="text-indigo-400" />
                </div>
              )}
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-indigo-600/20 text-indigo-100 border border-indigo-500/20'
                  : 'bg-[#0d1117] text-slate-200 border border-[#1e2433]'
              }`}>
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
          placeholder={`Ask a follow-up question about ${ticker}…`}
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
