'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Maximize2, Minimize2, GripVertical, Globe, ExternalLink, Loader2 } from 'lucide-react'
import { analysisApi, type DirectedReportRef } from '@/lib/api'
import clsx from 'clsx'
import MessageContent from './MessageContent'

interface Message {
  role: 'user' | 'assistant'
  content: string
  needsWeb?: boolean             // assistant wants approval to search (no answer otherwise)
  webQuery?: string              // approval-card query
  suggestedQuery?: string        // soft "also search" suggestion
  references?: DirectedReportRef[]
  pending?: boolean              // user already approved; awaiting response
  declined?: boolean             // user declined search
}

const MIN_W = 320
const MIN_H = 360
const STORAGE_KEY = 'ai_chat_panel_size_v1'

interface Size { w: number; h: number }

function loadSize(): Size {
  if (typeof window === 'undefined') return { w: 420, h: 600 }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.w === 'number' && typeof parsed.h === 'number') {
        return parsed
      }
    }
  } catch {}
  return { w: 420, h: 600 }
}

function clamp(size: Size): Size {
  if (typeof window === 'undefined') return size
  const maxW = window.innerWidth - 32
  const maxH = window.innerHeight - 32
  return {
    w: Math.max(MIN_W, Math.min(size.w, maxW)),
    h: Math.max(MIN_H, Math.min(size.h, maxH)),
  }
}

export default function AIChatPanel({
  onClose,
  onFirstMessage,
}: {
  onClose: () => void
  onFirstMessage: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [size, setSize] = useState<Size>({ w: 420, h: 600 })
  const [maximized, setMaximized] = useState(false)
  const [resizing, setResizing] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const firstMsg = useRef(false)
  const sizeBeforeMax = useRef<Size | null>(null)

  // Hydrate size from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    setSize(clamp(loadSize()))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Re-clamp on window resize
  useEffect(() => {
    const onResize = () => setSize(s => clamp(s))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startY = e.clientY
    const startW = size.w
    const startH = size.h

    const onMove = (ev: MouseEvent) => {
      // Panel is anchored bottom-right, so dragging the top-left grip:
      //   moving LEFT (dx < 0) → wider; moving UP (dy < 0) → taller
      const next = clamp({ w: startW - (ev.clientX - startX), h: startH - (ev.clientY - startY) })
      setSize(next)
    }
    const onUp = () => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(size)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [size])

  // Persist size when it settles
  useEffect(() => {
    if (resizing || maximized) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(size)) } catch {}
  }, [size, resizing, maximized])

  function toggleMaximize() {
    if (maximized) {
      setMaximized(false)
      if (sizeBeforeMax.current) setSize(clamp(sizeBeforeMax.current))
    } else {
      sizeBeforeMax.current = size
      setMaximized(true)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    if (!firstMsg.current) {
      firstMsg.current = true
      onFirstMessage()
    }
    const userMsg: Message = { role: 'user', content: text }
    const historyForApi = messages
      .filter(m => !m.needsWeb && !m.declined && !m.pending)
      .map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const res = await analysisApi.chat({ message: text, history: historyForApi })
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.response,
        needsWeb: res.needs_web,
        webQuery: res.web_query,
        suggestedQuery: res.suggested_web_query,
        references: res.references,
      }])
    } catch (e: unknown) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Error: ' + (e instanceof Error ? e.message : String(e)),
      }])
    } finally {
      setLoading(false)
    }
  }

  // Run a web-search follow-up after the user approves a suggestion.
  async function approveWebSearch(promptIdx: number, query: string, kind: 'needs' | 'suggest') {
    // Find the most recent user message before this assistant message
    let originalQ = ''
    for (let i = promptIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { originalQ = messages[i].content; break }
    }
    if (!originalQ) return
    // Suppress the buttons on the source bubble so the user can't double-click
    setMessages(prev => prev.map((m, i) => i === promptIdx
      ? (kind === 'needs'
          ? { ...m, pending: true, needsWeb: false }
          : { ...m, suggestedQuery: undefined })
      : m))
    setLoading(true)
    try {
      const historyForApi = messages
        .slice(0, promptIdx + 1) // include the assistant message we're following up on
        .filter(m => !m.needsWeb && !m.declined && !m.pending)
        .map(m => ({ role: m.role, content: m.content }))
      const res = await analysisApi.chat({
        message: originalQ,
        history: historyForApi,
        use_web: true,
        web_query: query,
      })
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.response,
        references: res.references,
      }])
    } catch (e: unknown) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Web search failed: ' + (e instanceof Error ? e.message : String(e)),
      }])
    } finally {
      setLoading(false)
    }
  }

  function declineWebSearch(promptIdx: number) {
    setMessages(prev => prev.map((m, i) => i === promptIdx ? { ...m, needsWeb: false, declined: true } : m))
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const panelStyle = maximized || isMobile
    ? { width: 'calc(100vw - 1rem)', height: 'calc(100vh - 4rem)', bottom: '0.5rem', right: '0.5rem' }
    : { width: size.w, height: size.h }

  return (
    <div
      style={panelStyle}
      className={clsx(
        'fixed bottom-4 right-4 z-50 flex flex-col rounded-xl border border-[#2d3148] bg-[#1a1d27] shadow-2xl shadow-black/60',
        !resizing && 'transition-[width,height] duration-150 ease-out',
      )}
    >
      {/* Resize grip — top-left corner (panel is anchored bottom-right) */}
      {!maximized && (
        <button
          onMouseDown={startResize}
          title="Drag to resize"
          aria-label="Resize chat panel"
          className="absolute -top-1 -left-1 w-5 h-5 flex items-center justify-center bg-[#252836] border border-[#2d3148] rounded-full text-slate-400 hover:text-white hover:bg-indigo-600 hover:border-indigo-500 cursor-nwse-resize transition-colors z-10"
        >
          <GripVertical size={11} className="rotate-45" />
        </button>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2d3148] shrink-0">
        <span className="font-semibold text-sm text-white">AI Chat</span>
        <div className="flex gap-1">
          <button
            onClick={toggleMaximize}
            title={maximized ? 'Restore' : 'Maximize'}
            className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors"
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-slate-500 text-sm text-center mt-8">
            Ask anything about the current news analysis. Markdown and basic HTML are rendered.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={clsx(
              'rounded-lg px-3 py-2 max-w-[92%] break-words',
              m.role === 'user'
                ? 'bg-indigo-600/20 text-indigo-100 ml-auto whitespace-pre-wrap text-sm leading-relaxed'
                : 'bg-[#252836] text-slate-200'
            )}
          >
            {m.role === 'assistant' ? <MessageContent content={m.content} /> : m.content}

            {m.role === 'assistant' && m.needsWeb && m.webQuery && (
              <div className="mt-3 flex flex-wrap items-center gap-2 pt-3 border-t border-white/5">
                <button
                  onClick={() => approveWebSearch(i, m.webQuery!, 'needs')}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs text-white font-medium"
                >
                  <Globe size={11} /> Search the web
                </button>
                <button
                  onClick={() => declineWebSearch(i)}
                  disabled={loading}
                  className="px-3 py-1.5 bg-white/5 hover:bg-white/10 disabled:opacity-50 rounded text-xs text-slate-300"
                >
                  No thanks
                </button>
                <span className="text-[10px] text-slate-500 ml-1">query: <span className="text-slate-300 font-mono">{m.webQuery}</span></span>
              </div>
            )}

            {m.role === 'assistant' && m.pending && (
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <Loader2 size={11} className="animate-spin" /> Searching the web…
              </div>
            )}

            {m.role === 'assistant' && m.declined && (
              <p className="mt-2 text-[10px] text-slate-600 italic">(web search declined)</p>
            )}

            {/* Soft "also search" suggestion — non-blocking pill */}
            {m.role === 'assistant' && m.suggestedQuery && !m.needsWeb && !m.pending && (
              <div className="mt-3 flex flex-wrap items-center gap-2 pt-3 border-t border-white/5">
                <span className="text-[10px] text-slate-500">Also search the web for more context?</span>
                <button
                  onClick={() => approveWebSearch(i, m.suggestedQuery!, 'suggest')}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 hover:bg-indigo-600/30 border border-white/10 hover:border-indigo-500/40 disabled:opacity-50 rounded text-xs text-slate-300 hover:text-white transition-colors"
                >
                  <Globe size={10} />
                  <span className="font-mono max-w-[180px] truncate">{m.suggestedQuery}</span>
                </button>
              </div>
            )}

            {m.role === 'assistant' && m.references && m.references.length > 0 && (() => {
              const articleRefs = m.references.filter(r => r.kind === 'article')
              const webRefs = m.references.filter(r => r.kind !== 'article')
              return (
                <div className="mt-3 pt-3 border-t border-white/5 space-y-2.5">
                  {articleRefs.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Articles cited</p>
                      {articleRefs.map((r, ri) => (
                        <a
                          key={ri}
                          href={r.id ? `/news?article=${r.id}` : r.url}
                          target={r.id ? undefined : '_blank'}
                          rel="noopener noreferrer"
                          className="flex items-start gap-2 group"
                        >
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono mt-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 flex-shrink-0">
                            A-{ri + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-300 group-hover:text-indigo-300 truncate">{r.title || r.url}</p>
                            {r.source && <p className="text-[10px] text-slate-600">{r.source}</p>}
                          </div>
                          <ExternalLink size={10} className="text-slate-600 group-hover:text-indigo-400 flex-shrink-0 mt-1" />
                        </a>
                      ))}
                    </div>
                  )}
                  {webRefs.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Web sources</p>
                      {webRefs.map((r, ri) => (
                        <a
                          key={ri}
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start gap-2 group"
                        >
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono mt-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex-shrink-0">
                            WEB-{ri + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-300 group-hover:text-emerald-300 truncate">{r.title || r.url}</p>
                            {r.source && <p className="text-[10px] text-slate-600">{r.source}</p>}
                          </div>
                          <ExternalLink size={10} className="text-slate-600 group-hover:text-emerald-400 flex-shrink-0 mt-1" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        ))}
        {loading && (
          <div className="bg-[#252836] rounded-lg px-3 py-2 text-sm text-slate-400 w-16 animate-pulse">
            ...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-[#2d3148] flex gap-2 shrink-0 items-end">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          placeholder="Ask a question… (Shift+Enter for new line, supports markdown)"
          className="flex-1 bg-[#0d1117] border border-[#2d3148] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors resize-none max-h-40 leading-relaxed"
          style={{ minHeight: 38 }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors text-white shrink-0"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
