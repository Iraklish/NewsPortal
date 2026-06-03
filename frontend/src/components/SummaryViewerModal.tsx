'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ScrollText, Search, Maximize2, Minimize2, X } from 'lucide-react'
import SummaryMarkdown from './SummaryMarkdown'
import { applyHighlights } from '@/lib/highlight'

/**
 * Pop-up viewer for a generated summary, with maximize/full-screen and an
 * in-content find box that highlights matches.
 */
export default function SummaryViewerModal({
  title,
  content,
  themes,
  onClose,
}: {
  title: string
  content: string
  themes?: string[]
  onClose: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [search, setSearch] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  // Memoize the body so typing in the find box doesn't re-render the markdown
  // subtree (which would wipe the injected highlight <mark> nodes).
  const body = useMemo(() => (
    <>
      <SummaryMarkdown content={content} />
      {themes && themes.length > 0 && (
        <div className="mt-5 pt-4 border-t border-[#1e2433]">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Key themes</p>
          <div className="flex flex-wrap gap-1.5">
            {themes.map((t, i) => (
              <span key={i} className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/30 rounded text-xs text-indigo-300">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  ), [content, themes])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    setMatchCount(applyHighlights(el, search))
  }, [search, maximized])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={clsx(
        'fixed inset-0 z-[60] bg-black/70 flex items-start justify-center overflow-y-auto',
        maximized ? 'p-0' : 'p-4 md:p-8',
      )}
      onClick={onClose}
    >
      <div
        className={clsx(
          'bg-[#0d1117] border border-[#1e2433] shadow-2xl flex flex-col',
          maximized ? 'w-full min-h-screen rounded-none' : 'w-full max-w-3xl my-auto rounded-2xl',
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2433]">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={16} className="text-indigo-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-white truncate">{title}</h2>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Find in summary…"
                className="w-32 sm:w-44 bg-[#0a0f1e] border border-[#1e2433] rounded-lg pl-7 pr-12 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              {search.trim() && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 tabular-nums">
                  {matchCount}
                </span>
              )}
            </div>
            <button
              onClick={() => setMaximized(m => !m)}
              title={maximized ? 'Restore' : 'Maximize'}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
            >
              {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div ref={contentRef} className={clsx('p-5 overflow-y-auto flex-1', maximized ? '' : 'max-h-[70vh]')}>
          {body}
        </div>
      </div>
    </div>
  )
}
