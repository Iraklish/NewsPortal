'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Loader2, Trash2, ShieldCheck, AlertCircle, Plus, Users, MessageCircle, Search, Power, LogOut,
} from 'lucide-react'
import clsx from 'clsx'
import { whatsappApi, type WhatsAppSource, type WhatsAppChat, type WhatsAppStatus } from '@/lib/api'

function fmt(s?: string): string {
  if (!s) return 'never'
  const ms = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? new Date(s).getTime() : new Date(s + 'Z').getTime()
  return new Date(ms).toLocaleString()
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [sources, setSources] = useState<WhatsAppSource[]>([])
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [loadingChats, setLoadingChats] = useState(false)
  const [chatFilter, setChatFilter] = useState('')
  const [showChats, setShowChats] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchingOne, setFetchingOne] = useState<number | null>(null)
  const [fetchMsg, setFetchMsg] = useState('')
  const [lookback, setLookback] = useState(24)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const ready = !!status?.ready
  const sessionStarting = connecting || !!status?.connecting

  const loadSources = useCallback(() => {
    whatsappApi.list().then(setSources).catch(() => {})
  }, [])

  const loadStatus = useCallback(() => {
    whatsappApi.authStatus().then(setStatus).catch(() => setStatus({ ready: false, authenticated: false, error: 'bridge unreachable' }))
  }, [])

  useEffect(() => {
    loadStatus()
    loadSources()
  }, [loadStatus, loadSources])

  // Poll only while a connect is in progress (QR scan flow) — not on idle.
  useEffect(() => {
    const active = !ready && (sessionStarting || !!status?.qr)
    if (!active) return
    const id = setInterval(loadStatus, 3000)
    return () => clearInterval(id)
  }, [ready, sessionStarting, status?.qr, loadStatus])

  // Once a QR appears or the session is ready, the local "connecting" flag can clear.
  useEffect(() => {
    if (status?.ready || status?.qr) setConnecting(false)
  }, [status?.ready, status?.qr])

  async function connectSession() {
    setConnecting(true)
    setError('')
    try {
      await whatsappApi.connect()
      await loadStatus()
    } catch (e: unknown) {
      setConnecting(false)
      setError(e instanceof Error ? e.message : 'Could not reach the WhatsApp bridge')
    }
  }

  async function disconnectSession() {
    try {
      await whatsappApi.disconnect()
      await loadStatus()
    } catch {}
  }

  async function loadChats() {
    setLoadingChats(true)
    setError('')
    try {
      const c = await whatsappApi.listChats()
      setChats(c)
      setShowChats(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load chats')
    } finally {
      setLoadingChats(false)
    }
  }

  async function addChat(chat: WhatsAppChat) {
    try {
      await whatsappApi.create({ chat_id: chat.id, name: chat.name, is_group: chat.isGroup, lookback_hours: lookback })
      setChats(cs => cs.map(c => (c.id === chat.id ? { ...c, already_added: true } : c)))
      loadSources()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not add chat')
    }
  }

  async function toggleEnabled(s: WhatsAppSource) {
    try {
      const u = await whatsappApi.update(s.id, { enabled: !s.enabled })
      setSources(prev => prev.map(x => (x.id === s.id ? u : x)))
    } catch {}
  }

  async function removeSource(id: number) {
    if (!window.confirm('Remove this chat?')) return
    try {
      await whatsappApi.remove(id)
      setSources(prev => prev.filter(x => x.id !== id))
    } catch {}
  }

  async function fetchAll() {
    setFetching(true)
    setFetchMsg('')
    try {
      const r = await whatsappApi.fetchAll()
      setFetchMsg(`${r.new_articles} new message${r.new_articles === 1 ? '' : 's'} from ${r.sources_fetched} chat${r.sources_fetched === 1 ? '' : 's'}`)
      loadSources()
    } catch (e: unknown) {
      setFetchMsg(e instanceof Error ? e.message : 'Fetch failed')
    } finally {
      setFetching(false)
      setTimeout(() => setFetchMsg(''), 6000)
    }
  }

  async function fetchOne(id: number) {
    setFetchingOne(id)
    try {
      await whatsappApi.fetchOne(id)
      loadSources()
    } catch {} finally { setFetchingOne(null) }
  }

  const filteredChats = chats.filter(c => !chatFilter || (c.name || c.id).toLowerCase().includes(chatFilter.toLowerCase()))

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <MessageCircle size={20} className="text-green-400" /> WhatsApp Channels
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Fetch messages from chats &amp; groups via the local WhatsApp bridge — stored as articles.
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={fetching || !ready}
          className="flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors"
        >
          {fetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Fetch now
        </button>
      </div>
      {fetchMsg && <p className="text-xs text-green-300 mb-4">{fetchMsg}</p>}

      {/* Connection / QR */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 mb-6">
        {ready ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-green-400 flex-1">
              <ShieldCheck size={16} /> WhatsApp connected
            </div>
            <button
              onClick={disconnectSession}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-red-400 border border-[#1e2433] hover:border-red-500/40 rounded-lg transition-colors"
            >
              <LogOut size={12} /> Disconnect
            </button>
          </div>
        ) : status?.qr ? (
          <div className="flex flex-col sm:flex-row items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={status.qr} alt="WhatsApp QR" className="w-44 h-44 rounded-lg bg-white p-2" />
            <div className="text-sm text-slate-400">
              <p className="text-white font-medium mb-1">Link your WhatsApp</p>
              <p>On your phone: <span className="text-slate-300">WhatsApp → Settings → Linked devices → Link a device</span>, then scan this code.</p>
              <p className="text-[11px] text-slate-600 mt-2">The QR refreshes automatically. Session is saved after the first scan.</p>
              <button onClick={disconnectSession} className="text-[11px] text-slate-500 hover:text-white mt-2 inline-flex items-center gap-1"><LogOut size={11} /> Cancel</button>
            </div>
          </div>
        ) : sessionStarting ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 size={15} className="animate-spin text-green-400" /> Starting session — generating QR…
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <AlertCircle size={15} className="text-amber-400" />
              {status?.error && status.error.startsWith('bridge unreachable')
                ? <>Bridge not running. Start it: <code className="text-slate-400 ml-1">cd whatsapp-bridge &amp;&amp; npm start</code></>
                : 'Not connected.'}
            </div>
            <button
              onClick={connectSession}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded-lg text-sm text-white font-medium transition-colors"
            >
              <Power size={13} /> Connect WhatsApp
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Discover chats */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-300">Add chats / groups</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              Lookback
              <input
                type="number" min={1} max={720} value={lookback}
                onChange={e => setLookback(Math.max(1, Math.min(720, parseInt(e.target.value) || 1)))}
                className="w-16 bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-green-500/50"
              />
              h
            </label>
            <button
              onClick={loadChats}
              disabled={loadingChats || !ready}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0a0f1e] border border-[#1e2433] hover:border-green-500/40 disabled:opacity-40 rounded-lg text-xs text-slate-300 transition-colors"
            >
              {loadingChats ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
              {showChats ? 'Reload chats' : 'Load chats'}
            </button>
          </div>
        </div>

        {showChats && (
          <>
            <input
              value={chatFilter}
              onChange={e => setChatFilter(e.target.value)}
              placeholder="Filter chats…"
              className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-green-500/50 mb-2"
            />
            <div className="max-h-72 overflow-y-auto divide-y divide-[#1e2433]">
              {filteredChats.length === 0 && <p className="text-xs text-slate-600 py-3">No chats.</p>}
              {filteredChats.map(c => (
                <div key={c.id} className="flex items-center gap-2 py-2">
                  {c.isGroup ? <Users size={13} className="text-green-400 flex-shrink-0" /> : <MessageCircle size={13} className="text-slate-500 flex-shrink-0" />}
                  <span className="text-sm text-slate-200 truncate flex-1">{c.name || c.id}</span>
                  {c.unreadCount > 0 && <span className="text-[10px] text-green-400">{c.unreadCount} unread</span>}
                  {c.already_added ? (
                    <span className="text-[10px] text-slate-600">added</span>
                  ) : (
                    <button onClick={() => addChat(c)} className="flex items-center gap-1 px-2 py-1 bg-green-600/20 border border-green-500/30 text-green-300 rounded text-[11px] hover:bg-green-600/30 transition-colors">
                      <Plus size={11} /> Add
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Tracked sources */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1e2433]">
          <h2 className="text-sm font-semibold text-slate-300">Tracked chats ({sources.length})</h2>
        </div>
        {sources.length === 0 ? (
          <p className="text-sm text-slate-500 p-4">No chats tracked yet. Load and add some above.</p>
        ) : (
          <div className="divide-y divide-[#1e2433]">
            {sources.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[#0a0f1e] transition-colors">
                {s.is_group ? <Users size={14} className="text-green-400 flex-shrink-0" /> : <MessageCircle size={14} className="text-slate-500 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{s.name || s.chat_id}</p>
                  <p className="text-[10px] text-slate-600">
                    <span className="text-slate-400 font-medium">{s.message_count.toLocaleString()}</span> msg · Lookback {s.lookback_hours}h · Last: {fmt(s.last_fetched_at)}
                    {s.last_error && <span className="text-red-400 ml-2">{s.last_error.slice(0, 60)}</span>}
                  </p>
                </div>
                <button onClick={() => fetchOne(s.id)} disabled={fetchingOne === s.id || !ready} title="Fetch now" className="p-1.5 text-slate-500 hover:text-green-400 transition-colors disabled:opacity-30">
                  {fetchingOne === s.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                </button>
                <button onClick={() => toggleEnabled(s)} className={clsx('text-[10px] px-2 py-1 rounded border transition-colors', s.enabled ? 'border-green-500/30 text-green-300 bg-green-500/10' : 'border-[#1e2433] text-slate-500')}>
                  {s.enabled ? 'enabled' : 'disabled'}
                </button>
                <button onClick={() => removeSource(s.id)} title="Remove" className="p-1.5 text-slate-600 hover:text-red-400 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
