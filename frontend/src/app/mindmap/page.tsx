'use client'

import { useEffect, useMemo, useState } from 'react'
import { mindmapApi, type MindMapOut, type MindMapAspect, type MindMapNode } from '@/lib/api'
import {
  Loader2, Trash2, Network, ChevronRight, ChevronDown, Search, X,
  Maximize2, Minimize2, ChevronsDown, ChevronsUp, Plus, Sparkles, FileText, FolderTree,
} from 'lucide-react'
import clsx from 'clsx'

const DEFAULT_ASPECTS = [
  'Economics', 'Politics', 'Technology', 'Risk', 'Society',
  'Markets', 'Geopolitics', 'Environment', 'Innovation', 'Legal',
]

function fmt(dateStr: string) {
  return new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z').toLocaleDateString()
}

// ── Tree model ───────────────────────────────────────────────────────────────
// Stable node ids used for expansion state and focus selection.

type FocusTarget =
  | { kind: 'root' }
  | { kind: 'aspect'; aspect: string }
  | { kind: 'category'; aspect: string; category: string }
  | { kind: 'item'; aspect: string; category: string; index: number }

function nodeKey(t: FocusTarget): string {
  if (t.kind === 'root') return 'root'
  if (t.kind === 'aspect') return `a:${t.aspect}`
  if (t.kind === 'category') return `c:${t.aspect}::${t.category}`
  return `i:${t.aspect}::${t.category}::${t.index}`
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function MindMapPage() {
  // Generator state
  const [subject, setSubject] = useState('')
  const [selectedAspects, setSelectedAspects] = useState<Set<string>>(new Set(DEFAULT_ASPECTS))
  const [customAspect, setCustomAspect] = useState('')
  const [extraAspects, setExtraAspects] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  // Map state
  const [current, setCurrent] = useState<MindMapOut | null>(null)
  const [savedMaps, setSavedMaps] = useState<MindMapOut[]>([])
  const [focus, setFocus] = useState<FocusTarget>({ kind: 'root' })
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']))
  const [filter, setFilter] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(true)
  const [generatorOpen, setGeneratorOpen] = useState(true)

  useEffect(() => {
    mindmapApi.list().then(setSavedMaps).catch(() => {})
  }, [])

  // ESC exits fullscreen
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  function toggleAspect(a: string) {
    setSelectedAspects(prev => {
      const next = new Set(prev)
      if (next.has(a)) next.delete(a); else next.add(a)
      return next
    })
  }

  function addCustom() {
    const v = customAspect.trim()
    if (!v || selectedAspects.has(v)) return
    setExtraAspects(prev => [...prev, v])
    setSelectedAspects(prev => new Set([...Array.from(prev), v]))
    setCustomAspect('')
  }

  function loadMap(m: MindMapOut) {
    setCurrent(m)
    setFocus({ kind: 'root' })
    // Auto-expand root and all aspects so the user sees structure immediately
    const e = new Set<string>(['root'])
    for (const asp of Object.keys(m.map_data.aspects || {})) e.add(`a:${asp}`)
    setExpanded(e)
  }

  async function generate() {
    if (!subject.trim() || selectedAspects.size === 0) return
    setGenerating(true)
    setError('')
    setCurrent(null)
    try {
      const res = await mindmapApi.generate(subject.trim(), Array.from(selectedAspects))
      loadMap(res)
      const updated = await mindmapApi.list()
      setSavedMaps(updated)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function deleteMindMap(id: number) {
    try {
      await mindmapApi.delete(id)
      setSavedMaps(prev => prev.filter(m => m.id !== id))
      if (current?.id === id) { setCurrent(null); setFocus({ kind: 'root' }) }
    } catch { /* ignore */ }
  }

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function allKeys(): string[] {
    if (!current) return ['root']
    const keys = ['root']
    for (const [asp, data] of Object.entries(current.map_data.aspects || {})) {
      keys.push(`a:${asp}`)
      for (const cat of data?.categories || []) {
        keys.push(`c:${asp}::${cat.kind}`)
      }
    }
    return keys
  }

  function expandAll() { setExpanded(new Set(allKeys())) }
  function collapseAll() { setExpanded(new Set(['root'])) }

  const allAspects = [...DEFAULT_ASPECTS, ...extraAspects]

  return (
    <>
      <div className={clsx('max-w-7xl mx-auto', fullscreen && 'hidden')}>
        <div className="mb-5 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Network size={22} className="text-indigo-400" />
              MindMap Research
            </h1>
            <p className="text-slate-500 text-sm mt-1">Drill into AI-generated subject maps as a treeview.</p>
          </div>
          {current && (
            <button
              onClick={() => setFullscreen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded text-xs text-slate-300 hover:text-white transition-colors"
              title="Fullscreen"
            >
              <Maximize2 size={12} /> Fullscreen
            </button>
          )}
        </div>

        <div className="grid grid-cols-[320px_1fr] gap-5">
          {/* Left rail */}
          <div className="space-y-3">
            <CollapsibleCard
              title="New MindMap"
              icon={Sparkles}
              open={generatorOpen}
              onToggle={() => setGeneratorOpen(v => !v)}
            >
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Subject</label>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && generate()}
                placeholder="e.g. Fed policy impact on credit"
                className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
              />
              <p className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 mt-3">Dimensions</p>
              <div className="flex flex-wrap gap-1">
                {allAspects.map(a => (
                  <button
                    key={a}
                    onClick={() => toggleAspect(a)}
                    className={clsx(
                      'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                      selectedAspects.has(a)
                        ? 'text-indigo-300 border-indigo-500/50 bg-indigo-500/10'
                        : 'text-slate-500 border-[#1e2433] hover:text-slate-300'
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 mt-2">
                <input
                  value={customAspect}
                  onChange={e => setCustomAspect(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCustom()}
                  placeholder="Custom dimension…"
                  className="flex-1 bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <button onClick={addCustom} className="p-1.5 text-slate-400 hover:text-white"><Plus size={12} /></button>
              </div>
              <button
                onClick={generate}
                disabled={generating || !subject.trim() || selectedAspects.size === 0}
                className="mt-3 w-full flex items-center justify-center gap-2 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-sm text-white font-semibold"
              >
                {generating ? <><Loader2 size={14} className="animate-spin" /> Researching…</> : 'Generate'}
              </button>
              {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            </CollapsibleCard>

            {savedMaps.length > 0 && (
              <CollapsibleCard
                title={`Saved (${savedMaps.length})`}
                icon={FileText}
                open={savedOpen}
                onToggle={() => setSavedOpen(v => !v)}
              >
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {savedMaps.map(m => (
                    <div key={m.id} className="flex items-center gap-1 group">
                      <button
                        onClick={() => loadMap(m)}
                        className={clsx(
                          'flex-1 text-left text-xs px-2 py-1.5 rounded transition-colors min-w-0',
                          current?.id === m.id
                            ? 'bg-indigo-600/20 text-indigo-300'
                            : 'text-slate-400 hover:text-white hover:bg-white/5',
                        )}
                      >
                        <div className="font-medium truncate">{m.subject}</div>
                        <div className="text-[10px] text-slate-600">{fmt(m.created_at)}</div>
                      </button>
                      <button onClick={() => deleteMindMap(m.id)} className="p-1 text-slate-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </CollapsibleCard>
            )}
          </div>

          {/* Main area */}
          <MindMapWorkspace
            current={current}
            generating={generating}
            subject={subject}
            focus={focus}
            setFocus={setFocus}
            expanded={expanded}
            toggleExpand={toggleExpand}
            expandAll={expandAll}
            collapseAll={collapseAll}
            filter={filter}
            setFilter={setFilter}
            embedded
          />
        </div>
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && current && (
        <div className="fixed inset-0 z-50 bg-[#0a0f1e] flex flex-col">
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[#1e2433]">
            <div className="flex items-center gap-2 min-w-0">
              <Network size={16} className="text-indigo-400 flex-shrink-0" />
              <h2 className="text-sm font-bold text-white truncate">{current.map_data.subject || current.subject}</h2>
              <span className="text-[10px] text-slate-600 ml-2 flex-shrink-0">{fmt(current.created_at)}</span>
            </div>
            <button
              onClick={() => setFullscreen(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#1e2433] hover:border-indigo-500/50 rounded text-xs text-slate-300 hover:text-white"
              title="Exit fullscreen (Esc)"
            >
              <Minimize2 size={12} /> Exit
            </button>
          </div>
          <div className="flex-1 overflow-hidden p-4">
            <MindMapWorkspace
              current={current}
              generating={false}
              subject={current.map_data.subject || current.subject}
              focus={focus}
              setFocus={setFocus}
              expanded={expanded}
              toggleExpand={toggleExpand}
              expandAll={expandAll}
              collapseAll={collapseAll}
              filter={filter}
              setFilter={setFilter}
              embedded={false}
            />
          </div>
        </div>
      )}
    </>
  )
}

// ── Workspace (tree + detail), shared by normal + fullscreen modes ──────────

function MindMapWorkspace({
  current, generating, subject, focus, setFocus, expanded, toggleExpand,
  expandAll, collapseAll, filter, setFilter, embedded,
}: {
  current: MindMapOut | null
  generating: boolean
  subject: string
  focus: FocusTarget
  setFocus: (f: FocusTarget) => void
  expanded: Set<string>
  toggleExpand: (k: string) => void
  expandAll: () => void
  collapseAll: () => void
  filter: string
  setFilter: (s: string) => void
  embedded: boolean
}) {
  if (!current && !generating) {
    return (
      <div className={clsx(
        'bg-[#0d1117] border border-[#1e2433] rounded-xl flex items-center justify-center text-slate-600',
        embedded ? 'min-h-[600px]' : 'h-full',
      )}>
        <div className="text-center">
          <FolderTree size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Generate a MindMap or select a saved one to start drilling in.</p>
        </div>
      </div>
    )
  }

  if (generating) {
    return (
      <div className={clsx(
        'bg-[#0d1117] border border-[#1e2433] rounded-xl flex flex-col items-center justify-center gap-3',
        embedded ? 'min-h-[600px]' : 'h-full',
      )}>
        <Loader2 size={32} className="animate-spin text-indigo-400" />
        <p className="text-sm text-slate-400">Researching {subject}…</p>
      </div>
    )
  }

  return (
    <div className={clsx(
      'grid gap-3',
      embedded ? 'grid-cols-1 md:grid-cols-[minmax(260px,1fr)_minmax(0,1.4fr)] min-h-[600px]' : 'grid-cols-[minmax(280px,1fr)_minmax(0,2fr)] h-full',
    )}>
      <TreePanel
        current={current!}
        focus={focus}
        setFocus={setFocus}
        expanded={expanded}
        toggleExpand={toggleExpand}
        expandAll={expandAll}
        collapseAll={collapseAll}
        filter={filter}
        setFilter={setFilter}
      />
      <DetailPanel current={current!} focus={focus} setFocus={setFocus} />
    </div>
  )
}

// ── Tree panel ──────────────────────────────────────────────────────────────

function TreePanel({
  current, focus, setFocus, expanded, toggleExpand, expandAll, collapseAll, filter, setFilter,
}: {
  current: MindMapOut
  focus: FocusTarget
  setFocus: (f: FocusTarget) => void
  expanded: Set<string>
  toggleExpand: (k: string) => void
  expandAll: () => void
  collapseAll: () => void
  filter: string
  setFilter: (s: string) => void
}) {
  const aspects = Object.entries(current.map_data.aspects || {})

  // Filter to nodes whose path or text matches.
  const matchesFilter = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return null
    const matched = new Set<string>()
    // Always show root + ancestors of any match
    const ensure = (key: string) => matched.add(key)
    for (const [asp, data] of aspects) {
      const aspHit = asp.toLowerCase().includes(q)
        || (data?.summary || '').toLowerCase().includes(q)
      let anyChild = false
      for (const cat of data?.categories || []) {
        const catHit = (cat.kind || '').toLowerCase().includes(q)
          || (cat.explanation || '').toLowerCase().includes(q)
        let itemHit = false
        for (const item of cat.items || []) {
          if ((item || '').toLowerCase().includes(q)) { itemHit = true; break }
        }
        if (catHit || itemHit) {
          ensure(`c:${asp}::${cat.kind}`)
          anyChild = true
        }
      }
      if (aspHit || anyChild) {
        ensure(`a:${asp}`)
        ensure('root')
      }
    }
    return matched
  }, [aspects, filter])

  function focused(target: FocusTarget): boolean {
    return nodeKey(focus) === nodeKey(target)
  }

  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl flex flex-col overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1e2433] flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search the tree…"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded pl-6 pr-7 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
              <X size={10} />
            </button>
          )}
        </div>
        <button onClick={expandAll} title="Expand all" className="p-1 text-slate-500 hover:text-white hover:bg-white/5 rounded">
          <ChevronsDown size={12} />
        </button>
        <button onClick={collapseAll} title="Collapse all" className="p-1 text-slate-500 hover:text-white hover:bg-white/5 rounded">
          <ChevronsUp size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 text-xs">
        {/* Root */}
        <TreeRow
          icon={Network}
          label={current.map_data.subject || current.subject}
          accent="text-indigo-300"
          bold
          focused={focused({ kind: 'root' })}
          onClick={() => setFocus({ kind: 'root' })}
          expanded={expanded.has('root')}
          onToggleExpand={() => toggleExpand('root')}
          depth={0}
          hasChildren={aspects.length > 0}
        />

        {expanded.has('root') && aspects.map(([asp, data], idx) => {
          const aKey = `a:${asp}`
          if (matchesFilter && !matchesFilter.has(aKey)) return null
          const aExp = expanded.has(aKey)
          const cats = data?.categories || []
          return (
            <div key={asp}>
              <TreeRow
                badge={String(idx + 1)}
                label={asp}
                accent="text-white"
                bold
                focused={focused({ kind: 'aspect', aspect: asp })}
                onClick={() => setFocus({ kind: 'aspect', aspect: asp })}
                expanded={aExp}
                onToggleExpand={() => toggleExpand(aKey)}
                depth={1}
                hasChildren={cats.length > 0}
                meta={cats.length ? `${cats.length}` : undefined}
              />
              {aExp && cats.map(cat => {
                const cKey = `c:${asp}::${cat.kind}`
                if (matchesFilter && !matchesFilter.has(cKey)) return null
                const cExp = expanded.has(cKey)
                const items = cat.items || []
                return (
                  <div key={cat.kind}>
                    <TreeRow
                      label={cat.kind}
                      accent="text-slate-300"
                      focused={focused({ kind: 'category', aspect: asp, category: cat.kind })}
                      onClick={() => setFocus({ kind: 'category', aspect: asp, category: cat.kind })}
                      expanded={cExp}
                      onToggleExpand={() => toggleExpand(cKey)}
                      depth={2}
                      hasChildren={items.length > 0}
                      meta={items.length ? `${items.length}` : undefined}
                    />
                    {cExp && items.map((item, j) => (
                      <TreeRow
                        key={j}
                        label={item}
                        accent="text-slate-400"
                        focused={focused({ kind: 'item', aspect: asp, category: cat.kind, index: j })}
                        onClick={() => setFocus({ kind: 'item', aspect: asp, category: cat.kind, index: j })}
                        depth={3}
                        leaf
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TreeRow({
  label, badge, icon: Icon, accent = 'text-slate-300', bold = false,
  focused, onClick, expanded, onToggleExpand, depth, hasChildren = false, leaf = false, meta,
}: {
  label: string
  badge?: string
  icon?: React.ComponentType<{ size?: number; className?: string }>
  accent?: string
  bold?: boolean
  focused?: boolean
  onClick: () => void
  expanded?: boolean
  onToggleExpand?: () => void
  depth: number
  hasChildren?: boolean
  leaf?: boolean
  meta?: string
}) {
  return (
    <div
      className={clsx(
        'flex items-center gap-1.5 px-1 py-1 rounded cursor-pointer group transition-colors',
        focused ? 'bg-indigo-500/15 ring-1 ring-indigo-500/40' : 'hover:bg-white/5',
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
      onClick={onClick}
    >
      {hasChildren ? (
        <button
          onClick={e => { e.stopPropagation(); onToggleExpand?.() }}
          className="text-slate-500 hover:text-white p-0.5 -ml-0.5"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      ) : (
        <span className="w-3 inline-block" />
      )}
      {Icon && <Icon size={11} className="text-indigo-400 flex-shrink-0" />}
      {badge && (
        <span className="text-[9px] px-1 py-0 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded font-mono flex-shrink-0">
          {badge}
        </span>
      )}
      <span className={clsx('truncate', accent, bold && 'font-semibold', leaf && 'text-[11px]')}>
        {label}
      </span>
      {meta && <span className="ml-auto text-[10px] text-slate-600 flex-shrink-0">{meta}</span>}
    </div>
  )
}

// ── Detail panel (drill-down) ────────────────────────────────────────────────

function DetailPanel({ current, focus, setFocus }: {
  current: MindMapOut
  focus: FocusTarget
  setFocus: (f: FocusTarget) => void
}) {
  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl flex flex-col overflow-hidden">
      <Breadcrumbs current={current} focus={focus} setFocus={setFocus} />
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {focus.kind === 'root' && <RootDetail map={current} setFocus={setFocus} />}
        {focus.kind === 'aspect' && <AspectDetail
          name={focus.aspect}
          aspect={current.map_data.aspects[focus.aspect]}
          setFocus={setFocus}
        />}
        {focus.kind === 'category' && <CategoryDetail
          aspectName={focus.aspect}
          categoryName={focus.category}
          aspect={current.map_data.aspects[focus.aspect]}
          setFocus={setFocus}
        />}
        {focus.kind === 'item' && <ItemDetail
          aspectName={focus.aspect}
          categoryName={focus.category}
          itemIndex={focus.index}
          aspect={current.map_data.aspects[focus.aspect]}
          setFocus={setFocus}
        />}
      </div>
    </div>
  )
}

function Breadcrumbs({ current, focus, setFocus }: {
  current: MindMapOut; focus: FocusTarget; setFocus: (f: FocusTarget) => void
}) {
  const crumbs: { label: string; target: FocusTarget }[] = [
    { label: current.map_data.subject || current.subject, target: { kind: 'root' } },
  ]
  if (focus.kind !== 'root') {
    crumbs.push({ label: focus.aspect, target: { kind: 'aspect', aspect: focus.aspect } })
  }
  if (focus.kind === 'category' || focus.kind === 'item') {
    crumbs.push({ label: focus.category, target: { kind: 'category', aspect: focus.aspect, category: focus.category } })
  }
  if (focus.kind === 'item') {
    const item = current.map_data.aspects[focus.aspect]?.categories
      ?.find(c => c.kind === focus.category)?.items?.[focus.index] || ''
    const short = item.length > 50 ? item.slice(0, 50) + '…' : item
    crumbs.push({ label: short, target: focus })
  }
  return (
    <div className="px-4 py-2.5 border-b border-[#1e2433] flex items-center gap-1 flex-wrap text-xs">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={11} className="text-slate-600" />}
          <button
            onClick={() => setFocus(c.target)}
            className={clsx(
              'truncate max-w-[280px] transition-colors',
              i === crumbs.length - 1 ? 'text-white font-medium' : 'text-slate-400 hover:text-indigo-300',
            )}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  )
}

function RootDetail({ map, setFocus }: { map: MindMapOut; setFocus: (f: FocusTarget) => void }) {
  const d = map.map_data
  const aspects = Object.entries(d.aspects || {})
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white">{d.subject || map.subject}</h2>
        <p className="text-[10px] text-slate-600 mt-1">
          {fmt(map.created_at)}{map.model_used ? ` · ${map.model_used}` : ''} · {aspects.length} dimensions
        </p>
      </div>
      {d.summary && <Section title="Summary" body={d.summary} />}
      {d.reasoning && <Section title="Reasoning" body={d.reasoning} accent="text-amber-400" />}
      {d.whyItMatters && <Section title="Why It Matters" body={d.whyItMatters} accent="text-pink-400" />}
      {d.outcome && <Section title="Outcome" body={d.outcome} accent="text-emerald-400" />}
      {d.prognosis && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {d.prognosis.shortTerm && (
            <div className="bg-[#0a0f1e] rounded-lg p-3 border border-indigo-500/30">
              <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-1">Short-term</p>
              <p className="text-sm text-slate-200 leading-relaxed">{d.prognosis.shortTerm}</p>
            </div>
          )}
          {d.prognosis.longTerm && (
            <div className="bg-[#0a0f1e] rounded-lg p-3 border border-pink-500/30">
              <p className="text-[10px] font-bold text-pink-400 uppercase tracking-wider mb-1">Long-term</p>
              <p className="text-sm text-slate-200 leading-relaxed">{d.prognosis.longTerm}</p>
            </div>
          )}
        </div>
      )}
      <div>
        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Dimensions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {aspects.map(([asp, data]) => (
            <button
              key={asp}
              onClick={() => setFocus({ kind: 'aspect', aspect: asp })}
              className="text-left bg-[#0a0f1e] border border-[#1e2433] hover:border-indigo-500/40 rounded-lg p-3 transition-colors group"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-semibold text-white">{asp}</span>
                <span className="text-[10px] text-slate-600">{(data?.categories || []).length} groups</span>
              </div>
              {data?.summary && <p className="text-xs text-slate-500 line-clamp-2">{data.summary}</p>}
              <span className="text-[10px] text-indigo-400 mt-1.5 inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                Drill in <ChevronRight size={10} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function AspectDetail({ name, aspect, setFocus }: {
  name: string
  aspect?: MindMapAspect
  setFocus: (f: FocusTarget) => void
}) {
  if (!aspect) return <p className="text-sm text-slate-500">No data for this dimension.</p>
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-white">{name}</h2>
      {aspect.summary && <Section title="Summary" body={aspect.summary} />}
      {aspect.reasoning && <Section title="Reasoning" body={aspect.reasoning} accent="text-amber-400" />}
      {aspect.whyItMatters && <Section title="Why It Matters" body={aspect.whyItMatters} accent="text-pink-400" />}
      <div>
        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Categories</h3>
        <div className="space-y-2">
          {(aspect.categories || []).map(cat => (
            <button
              key={cat.kind}
              onClick={() => setFocus({ kind: 'category', aspect: name, category: cat.kind })}
              className="w-full text-left bg-[#0a0f1e] border border-[#1e2433] hover:border-indigo-500/40 rounded-lg p-3 transition-colors group"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-semibold text-white">{cat.kind}</span>
                <span className="text-[10px] text-slate-600">{cat.items?.length || 0} items</span>
              </div>
              {cat.explanation && <p className="text-xs text-slate-500 line-clamp-2">{cat.explanation}</p>}
              <span className="text-[10px] text-indigo-400 mt-1.5 inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                Drill in <ChevronRight size={10} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function CategoryDetail({ aspectName, categoryName, aspect, setFocus }: {
  aspectName: string
  categoryName: string
  aspect?: MindMapAspect
  setFocus: (f: FocusTarget) => void
}) {
  const cat: MindMapNode | undefined = aspect?.categories?.find(c => c.kind === categoryName)
  if (!cat) return <p className="text-sm text-slate-500">Category not found.</p>
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-white">{categoryName}</h2>
      <p className="text-xs text-slate-500">in <span className="text-indigo-400">{aspectName}</span></p>
      {cat.explanation && <Section title="Explanation" body={cat.explanation} />}
      <div>
        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Items ({cat.items?.length || 0})</h3>
        <div className="space-y-1.5">
          {(cat.items || []).map((item, i) => (
            <button
              key={i}
              onClick={() => setFocus({ kind: 'item', aspect: aspectName, category: categoryName, index: i })}
              className="w-full text-left bg-[#0a0f1e] border border-[#1e2433] hover:border-indigo-500/40 rounded-lg p-3 transition-colors group flex items-start gap-2"
            >
              <span className="text-[10px] text-indigo-400 font-mono mt-0.5">{i + 1}.</span>
              <span className="flex-1 text-sm text-slate-200">{item}</span>
              <ChevronRight size={12} className="text-slate-600 group-hover:text-indigo-400 transition-colors flex-shrink-0 mt-1" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ItemDetail({ aspectName, categoryName, itemIndex, aspect, setFocus }: {
  aspectName: string
  categoryName: string
  itemIndex: number
  aspect?: MindMapAspect
  setFocus: (f: FocusTarget) => void
}) {
  const cat = aspect?.categories?.find(c => c.kind === categoryName)
  const item = cat?.items?.[itemIndex]
  if (!item) return <p className="text-sm text-slate-500">Item not found.</p>
  const siblings = cat?.items || []
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white leading-snug">{item}</h2>
      <div className="text-xs text-slate-500">
        <span className="text-indigo-400">{aspectName}</span>
        {' › '}
        <span className="text-slate-400">{categoryName}</span>
      </div>
      {cat?.explanation && (
        <div className="bg-[#0a0f1e] rounded-lg p-3 border border-[#1e2433]">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Category explanation</p>
          <p className="text-sm text-slate-300 leading-relaxed">{cat.explanation}</p>
        </div>
      )}
      {siblings.length > 1 && (
        <div>
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            Other items in this category
          </h3>
          <div className="space-y-1">
            {siblings.map((s, i) => i === itemIndex ? null : (
              <button
                key={i}
                onClick={() => setFocus({ kind: 'item', aspect: aspectName, category: categoryName, index: i })}
                className="w-full text-left text-xs text-slate-400 hover:text-white px-2 py-1.5 rounded hover:bg-white/5 transition-colors flex items-start gap-2"
              >
                <span className="text-indigo-400 font-mono flex-shrink-0">{i + 1}.</span>
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, body, accent }: { title: string; body: string; accent?: string }) {
  return (
    <div>
      <h3 className={clsx('text-[10px] font-bold uppercase tracking-wider mb-1.5', accent || 'text-slate-500')}>{title}</h3>
      <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{body}</p>
    </div>
  )
}

// ── Generic collapsible card ─────────────────────────────────────────────────

function CollapsibleCard({ title, icon: Icon, open, onToggle, children }: {
  title: string
  icon?: React.ComponentType<{ size?: number; className?: string }>
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <span className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
          {Icon && <Icon size={12} className="text-indigo-400" />}
          {title}
        </span>
        {open ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}
