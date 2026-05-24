'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, LineChart, Network, Settings, MessageSquare, Newspaper, FileText } from 'lucide-react'
import { useState } from 'react'
import AIChatPanel from './AIChatPanel'

const nav = [
  { href: '/news', label: 'News', icon: Newspaper },
  { href: '/analysis', label: 'Analysis & Prognosis', icon: BarChart2 },
  { href: '/stocks', label: 'Stock Reviews', icon: LineChart },
  { href: '/mindmap', label: 'MindMap', icon: Network },
  { href: '/logs', label: 'Logs', icon: FileText },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [chatOpen, setChatOpen] = useState(false)
  const [chatUsed, setChatUsed] = useState(false)

  return (
    <>
      <aside className="fixed left-0 top-0 h-screen w-64 bg-[#0d1117] border-r border-[#1e2433] flex flex-col z-40">
        <div className="p-6 border-b border-[#1e2433]">
          <h1 className="text-lg font-bold text-white">NewsPortal</h1>
          <p className="text-xs text-slate-500 mt-1">News Intelligence</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon size={16} />
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-[#1e2433]">
          <button
            onClick={() => setChatOpen(v => !v)}
            className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-white/5 transition-colors relative"
          >
            <MessageSquare size={16} />
            AI Chat
            {chatUsed && (
              <span className="absolute right-3 top-2 w-2 h-2 rounded-full bg-blue-500" />
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
