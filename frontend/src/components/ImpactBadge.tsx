import { ChevronsUp, TrendingUp, Minus, TrendingDown, ChevronsDown } from 'lucide-react'
import type { ImpactType } from '@/lib/api'

const CONFIG: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  highly_positive: {
    label: 'Highly Positive',
    icon: ChevronsUp,
    className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  },
  positive: {
    label: 'Positive',
    icon: TrendingUp,
    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  },
  neutral: {
    label: 'Neutral',
    icon: Minus,
    className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  },
  negative: {
    label: 'Negative',
    icon: TrendingDown,
    className: 'bg-red-500/10 text-red-400 border-red-500/25',
  },
  highly_negative: {
    label: 'Highly Negative',
    icon: ChevronsDown,
    className: 'bg-red-500/20 text-red-300 border-red-500/40',
  },
}

export default function ImpactBadge({
  type,
  size = 'md',
}: {
  type?: ImpactType | string
  size?: 'sm' | 'md'
}) {
  if (!type) return null
  const cfg = CONFIG[type] || CONFIG.neutral
  const Icon = cfg.icon
  return (
    <span
      className={`inline-flex items-center gap-1 border rounded-full font-semibold ${cfg.className} ${
        size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-xs px-2.5 py-1'
      }`}
    >
      <Icon size={size === 'sm' ? 10 : 12} />
      {cfg.label}
    </span>
  )
}
