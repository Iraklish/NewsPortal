'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { BarChart2, LineChart, Network, Settings, MessageSquare, Newspaper, FileText, Menu, X, Send, Search, Tv } from 'lucide-react'
import { useEffect, useState } from 'react'
import AIChatPanel from './AIChatPanel'

type NavItem = {
  href: string
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>
  /** When set, this item links to `href?category=<category>` and is only
   *  active when both the pathname and the ?category param match. */
  category?: string
}

const nav: NavItem[] = [
  { href: '/news', label: 'News', icon: Newspaper },
  { href: '/news', label: 'Entertainment', icon: Tv, category: 'entertainment' },
  { href: '/analysis', label: 'Analysis & Prognosis', icon: BarChart2 },
  { href: '/stocks', label: 'Stock Reviews', icon: LineChart },
  { href: '/search', label: 'Web Search', icon: Search },
  { href: '/mindmap', label: 'MindMap', icon: Network },
  { href: '/telegram', label: 'Telegram', icon: Send },
  { href: '/logs', label: 'Logs', icon: FileText },
  { href: '/settings', label: 'Settings', icon: Settings },
]

/** Category values that have dedicated sidebar entries on the same base path. */
const EXCLUSIVE_CATEGORIES = new Set(
  nav.filter(n => n.category).map(n => n.category as string),
)

export default function Sidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const catParam = searchParams.get('category') ?? ''
  const [open, setOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatUsed, setChatUsed] = useState(false)

  // Close sidebar on route change (mobile nav tap)
  useEffect(() => { setOpen(false) }, [pathname])

  function isActive(item: NavItem): boolean {
    if (item.category) {
      // Category-pinned item: active only when pathname AND category param both match
      return pathname === item.href && catParam === item.category
    }
    const pathMatch = pathname === item.href || pathname.startsWith(item.href + '/')
    if (!pathMatch) return false
    // For base paths that have exclusive category entries (e.g. /news → entertainment),
    // the generic item is active only when the current category isn't one of those.
    if (EXCLUSIVE_CATEGORIES.size > 0 && item.href === '/news') {
      return !EXCLUSIVE_CATEGORIES.has(catParam)
    }
    return true
  }

  return (
    <>
      {/* ── Mobile top bar ───────────────────────────────────────────────── */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-12 z-40 bg-[#0d1117] border-b border-[#1e2433] flex items-center px-3 gap-3">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Menu size={20} />
        </button>
        <span className="text-sm font-bold text-white">NewsPortal</span>
        <div className="flex-1" />
        <button
          onClick={() => setChatOpen(v => !v)}
          aria-label="AI Chat"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors relative"
        >
          <MessageSquare size={18} />
          {chatUsed && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-500" />
          )}
        </button>
      </div>

      {/* ── Overlay (mobile only) ────────────────────────────────────────── */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside
        className={[
          'fixed left-0 top-0 h-screen w-64 bg-[#0d1117] border-r border-[#1e2433] flex flex-col z-50',
          'transition-transform duration-200 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
      >
        {/* Header */}
        <div className="p-5 border-b border-[#1e2433] flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-white">NewsPortal</h1>
            <p className="text-xs text-slate-500 mt-0.5">News Intelligence</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="md:hidden p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {nav.map((item) => {
            const { href, label, icon: Icon, category } = item
            const linkHref = category ? `${href}?category=${category}` : href
            const active = isActive(item)
            return (
              <Link
                key={linkHref}
                href={linkHref}
                className={[
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5',
                ].join(' ')}
              >
                <Icon size={16} />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* AI Chat button */}
        <div className="p-3 border-t border-[#1e2433]">
          <button
            onClick={() => { setChatOpen(v => !v); setOpen(false) }}
            className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-white/5 transition-colors relative"
          >
            <MessageSquare size={16} />
            AI Chat
            {chatUsed && (
              <span className="absolute right-3 top-2.5 w-2 h-2 rounded-full bg-blue-500" />
            )}
          </button>
        </div>
      </aside>

      {chatOpen && (
        <AIChatPanel
          onClose={() => setChatOpen(false)}
          onFirstMessage={() => setChatUsed(true)}
        />
      )}
    </>
  )
}
