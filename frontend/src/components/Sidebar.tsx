'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, LineChart, Network, Settings, MessageSquare, MessageCircle, Newspaper, FileText, Menu, X, Send, Search, ScrollText, Languages, LogOut, UserCircle, Twitter, Type, Minus, Plus, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import AIChatPanel from './AIChatPanel'
import { useLanguage, LANGUAGES, Lang } from '@/lib/language'
import { useFontSize } from '@/lib/fontsize'
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
  { href: '/twitter', label: 'Twitter / X', icon: Twitter },
  { href: '/logs', label: 'Logs', icon: FileText },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(true)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatUsed, setChatUsed] = useState(false)
  const { language, setLanguage } = useLanguage()
  const { scale, increase, decrease, reset, canIncrease, canDecrease } = useFontSize()
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

        {/* Nav links (collapsible) */}
        <div className="flex-1 overflow-y-auto">
          <button
            onClick={() => setNavOpen(v => !v)}
            className="flex items-center gap-2 w-full px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-white transition-colors"
          >
            {navOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Menu size={12} className="text-indigo-400" />
            Menu
          </button>
          {navOpen && (
            <nav className="px-3 pb-3 space-y-0.5">
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
          )}
        </div>

        {/* Preferences: language & font size (compact, collapsible) */}
        <div className="border-t border-[#1e2433]">
          <button
            onClick={() => setPrefsOpen(v => !v)}
            className="flex items-center gap-2 w-full px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-white transition-colors"
          >
            {prefsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <SlidersHorizontal size={12} className="text-indigo-400" />
            Preferences
          </button>
          {prefsOpen && (
            <div className="px-3 pb-3 space-y-2.5">
              {/* Language */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1 px-1">
                  <Languages size={11} className="text-indigo-400" />
                  Language
                </label>
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value as Lang)}
                  className={[
                    'w-full px-2 py-1.5 rounded-lg text-xs bg-[#0a0f1e] border outline-none transition-colors cursor-pointer',
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

              {/* Font size */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1 px-1">
                  <Type size={11} className="text-indigo-400" />
                  Font size
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={decrease}
                    disabled={!canDecrease}
                    title="Smaller text"
                    aria-label="Decrease font size"
                    className="p-1.5 rounded-lg border border-[#1e2433] text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Minus size={12} />
                  </button>
                  <button
                    onClick={reset}
                    title="Reset to 100%"
                    aria-label="Reset font size"
                    className="flex-1 px-2 py-1.5 rounded-lg border border-[#1e2433] text-[11px] font-medium text-slate-300 hover:text-white hover:border-slate-600 transition-colors"
                  >
                    {scale}%
                  </button>
                  <button
                    onClick={increase}
                    disabled={!canIncrease}
                    title="Larger text"
                    aria-label="Increase font size"
                    className="p-1.5 rounded-lg border border-[#1e2433] text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            </div>
          )}
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
