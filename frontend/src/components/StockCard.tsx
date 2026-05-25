'use client'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { StockAnalysis } from '@/lib/api'
import ImpactBadge from './ImpactBadge'

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

  return (
    <div className="rounded-xl border border-[#1e2433] bg-[#0d1117] p-6 space-y-5">
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
    </div>
  )
}
