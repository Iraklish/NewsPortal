import type { Analysis, ImpactType } from '@/lib/api'
import ImpactBadge from './ImpactBadge'

function dominantImpact(analyses: Analysis[]): ImpactType {
  const counts: Record<string, number> = {}
  analyses.forEach(a => {
    if (a.impact_type) counts[a.impact_type] = (counts[a.impact_type] || 0) + 1
  })
  return (
    (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral') as ImpactType
  )
}

export default function DirectedSummaryCard({
  analyses,
  focus,
}: {
  analyses: Analysis[]
  focus: string
}) {
  if (!analyses.length) return null
  const impact = dominantImpact(analyses)
  const sectors = [...new Set(analyses.flatMap(a => a.affected_sectors || []))]
  const regions = [...new Set(analyses.flatMap(a => a.affected_regions || []))]
  const avgConf =
    analyses.reduce((s, a) => s + (a.confidence_score || 0), 0) / analyses.length

  // Gather all categories across analyses
  const allCategories: Record<string, Set<string>> = {}
  analyses.forEach(a => {
    Object.entries(a.categories || {}).forEach(([cat, items]) => {
      if (!allCategories[cat]) allCategories[cat] = new Set()
      ;(items as string[]).forEach(item => allCategories[cat].add(item))
    })
  })

  return (
    <div className="rounded-xl border border-amber-500/30 bg-[#1a1610] p-5 mt-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-1">
            Directed Analysis
          </p>
          <h3 className="text-white font-semibold">{focus}</h3>
        </div>
        <ImpactBadge type={impact} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Analyses', value: analyses.length },
          { label: 'Sectors', value: sectors.length },
          { label: 'Regions', value: regions.length },
          { label: 'Confidence', value: `${Math.round(avgConf * 100)}%` },
        ].map(s => (
          <div key={s.label} className="bg-[#0d0f18] rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-white">{s.value}</div>
            <div className="text-xs text-slate-500">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Category grid */}
      {Object.keys(allCategories).length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-4">
          {Object.entries(allCategories)
            .slice(0, 6)
            .map(([cat, items]) => (
              <div key={cat} className="bg-[#0d0f18] rounded-lg p-3 border border-[#1e2433]">
                <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">
                  {cat}
                </p>
                <div className="flex flex-wrap gap-1">
                  {[...items].slice(0, 4).map(item => (
                    <span
                      key={item}
                      className="text-xs px-1.5 py-0.5 rounded bg-[#1e2433] text-slate-300"
                    >
                      {item}
                    </span>
                  ))}
                  {items.size > 4 && (
                    <span className="text-xs text-slate-500">+{items.size - 4}</span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Top events */}
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        Top Events
      </p>
      {analyses.slice(0, 3).map((a, i) => (
        <div key={i} className="mb-2 p-3 bg-[#0d0f18] rounded-lg border border-[#1e2433]">
          <div className="flex items-center gap-2 mb-1">
            <ImpactBadge type={a.impact_type as ImpactType} size="sm" />
            <span className="text-xs text-slate-500">
              {new Date(a.created_at).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-sm text-slate-300">
            {a.summary || a.economic_impact || 'No summary'}
          </p>
        </div>
      ))}

      {/* Regions */}
      {regions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {regions.slice(0, 10).map(r => (
            <span
              key={r}
              className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20"
            >
              {r}
            </span>
          ))}
          {regions.length > 10 && (
            <span className="text-xs text-slate-500">+{regions.length - 10} more</span>
          )}
        </div>
      )}
    </div>
  )
}
