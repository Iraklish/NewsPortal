'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, LineChart, Network, Settings, MessageSquare, MessageCircle, Newspaper, FileText, Menu, X, Send, Search, ScrollText, Languages, LogOut, UserCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import AIChatPanel from './AIChatPanel'
import { useLanguage, LANGUAGES, Lang } from '@/lib/language'
import { useAuth } from '@/lib/auth'

const nav = [
  { href: '/news', label: 'News', icon: Newspaper },
  { href: '/summary', label: 'Summary', icon: ScrollText },
  { href: '/stocks', label: 'Stock Reviews', icon: LineChart },
  { href: '/search', label: 'Web Search', icon: Search },
  { href: '/mindmap', label: 'MindMap', icon: Network },
  { href: '/analysis', label: 'Analysis & Prognosis', icon: BarChart2 },
  { href: '/telegram', label: 'Telegram', icon: Send },
  { href: '/whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { href: '/logs', label: 'Logs', icon: FileText },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatUsed, setChatUsed] = useState(false)
  const { language, setLanguage } = useLanguage()
  const { user, logout } = useAuth()

  // Close sidebar on route change (mobile nav tap)
  useEffect(() => { setOpen(false) }, [pathname])

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
          {nav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
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

        {/* Global language selector */}
        <div className="p-3 border-t border-[#1e2433]">
          <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5 px-1">
            <Languages size={13} className="text-indigo-400" />
            Language
          </label>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as Lang)}
            className={[
              'w-full px-3 py-2 rounded-lg text-sm bg-[#0a0f1e] border outline-none transition-colors cursor-pointer',
              language !== 'English'
                ? 'border-indigo-500/40 text-indigo-300'
                : 'border-[#1e2433] text-slate-300 hover:border-slate-600',
            ].join(' ')}
          >
            {LANGUAGES.map(l => (
              <option key={l} value={l} className="bg-[#0d1117]">{l}</option>
            ))}
          </select>
        </div>

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

        {/* Signed-in user + logout */}
        {user && (
          <div className="p-3 border-t border-[#1e2433] flex items-center gap-2">
            <UserCircle size={18} className="text-slate-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-slate-300 truncate">{user.username}</p>
              <p className="text-[10px] text-slate-600">{user.is_admin ? 'Administrator' : 'User'}</p>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-white/5 transition-colors flex-shrink-0"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
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
