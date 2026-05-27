'use client'

import { useEffect, useState } from 'react'
import { telegramApi, settingsApi, type TelegramSource } from '@/lib/api'
import {
  Send, Plus, Trash2, RefreshCw, Loader2, CheckCircle2, XCircle,
  AlertCircle, Clock, ChevronDown, ChevronUp, ShieldCheck,
} from 'lucide-react'
import clsx from 'clsx'

type AuthStep = 'idle' | 'sending' | 'entering_code' | 'signing_in' | 'done' | 'error'

function fmt(s?: string | null) {
  if (!s) return '—'
  const ms = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? new Date(s).getTime() : new Date(s + 'Z').getTime()
  return new Date(ms).toLocaleString()
}

function StatusDot({ status }: { status?: string | null }) {
  if (!status) return <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />
  if (status === 'ok') return <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
  if (status === 'empty') return <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
  return <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
}

export default function TelegramPage() {
  const [sources, setSources] = useState<TelegramSource[]>([])
  const [loading, setLoading] = useState(true)
  const [authOk, setAuthOk] = useState<boolean | null>(null)
  const [authReason, setAuthReason] = useState('')

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('idle')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [twoFaPass, setTwoFaPass] = useState('')
  const [authError, setAuthError] = useState('')
  const [showAuth, setShowAuth] = useState(false)

  // Add channel
  const [showAdd, setShowAdd] = useState(false)
  const [newChannelId, setNewChannelId] = useState('')
  const [newChannelName, setNewChannelName] = useState('')
  const [newLookback, setNewLookback] = useState(1)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

  // Fetch
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<{ sources_fetched: number; new_articles: number } | null>(null)
  const [fetchingOne, setFetchingOne] = useState<number | null>(null)

  async function loadAll() {
    setLoading(true)
    try {
      const [srcs, auth] = await Promise.all([
        telegramApi.list(),
        telegramApi.authStatus(),
      ])
      setSources(srcs)
      setAuthOk(auth.authorized)
      setAuthReason(auth.reason ?? '')
    } catch {}
    finally { setLoading(false) }
  }

  useEffect(() => { loadAll() }, [])

  // ── Auth ──────────────────────────────────────────────────────────────────

  async function sendCode() {
    if (!phone.trim()) return
    setAuthStep('sending')
    setAuthError('')
    try {
      await telegramApi.requestCode(phone.trim())
      setAuthStep('entering_code')
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : String(e))
      setAuthStep('error')
    }
  }

  async function doSignIn() {
    if (!code.trim()) return
    setAuthStep('signing_in')
    setAuthError('')
    try {
      const r = await telegramApi.signIn(code.trim(), twoFaPass || undefined)
      if (r.authorized) {
        setAuthStep('done')
        setAuthOk(true)
        setShowAuth(false)
      } else {
        setAuthError('Sign-in returned unauthorized — check your code')
        setAuthStep('error')
      }
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : String(e))
      setAuthStep('error')
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async function addChannel() {
    if (!newChannelId.trim()) return
    setAdding(true)
    setAddError('')
    try {
      const src = await telegramApi.create({
        channel_id: newChannelId.trim(),
        name: newChannelName.trim() || undefined,
        lookback_hours: newLookback,
        enabled: true,
      })
      setSources(s => [...s, src])
      setNewChannelId('')
      setNewChannelName('')
      setNewLookback(1)
      setShowAdd(false)
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  async function toggleEnabled(src: TelegramSource) {
    try {
      const updated = await telegramApi.update(src.id, { enabled: !src.enabled })
      setSources(s => s.map(x => x.id === src.id ? updated : x))
    } catch {}
  }

  async function deleteSource(id: number) {
    if (!confirm('Delete this Telegram channel?')) return
    try {
      await telegramApi.delete(id)
      setSources(s => s.filter(x => x.id !== id))
    } catch {}
  }

  async function fetchAll() {
    setFetching(true)
    setFetchResult(null)
    try {
      const r = await telegramApi.fetchAll()
      setFetchResult(r)
      await loadAll()
    } catch {} finally { setFetching(false) }
  }

  async function fetchOne(id: number) {
    setFetchingOne(id)
    try {
      await telegramApi.fetchOne(id)
      await loadAll()
    } catch {} finally { setFetchingOne(null) }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const credOk = authReason !== 'credentials_not_configured'

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Send size={20} className="text-blue-400" />
            Telegram Channels
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Messages are fetched on the same schedule as RSS feeds and stored as articles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadAll}
            className="p-2 text-slate-500 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={fetchAll}
            disabled={fetching || !authOk}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors"
          >
            {fetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Fetch now
          </button>
        </div>
      </div>

      {fetchResult && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-300 text-sm flex items-center gap-2">
          <CheckCircle2 size={14} />
          Fetched {fetchResult.sources_fetched} channel(s) — {fetchResult.new_articles} new article(s)
        </div>
      )}

      {/* Auth status card */}
      <div className={clsx(
        'bg-[#0d1117] border rounded-xl p-4 mb-6',
        authOk ? 'border-emerald-500/30' : 'border-yellow-500/30',
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className={authOk ? 'text-emerald-400' : 'text-yellow-400'} />
            <span className="text-sm font-medium text-white">
              {authOk ? 'Session authorised' : 'Not authorised'}
            </span>
            {!credOk && (
              <span className="text-[10px] text-slate-500">— set api_id &amp; api_hash in Settings first</span>
            )}
          </div>
          {!authOk && credOk && (
            <button
              onClick={() => setShowAuth(v => !v)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {showAuth ? 'Hide' : 'Sign in'} {showAuth ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>

        {showAuth && !authOk && (
          <div className="mt-4 space-y-3 border-t border-[#1e2433] pt-4">
            {(authStep === 'idle' || authStep === 'error') && (
              <>
                <p className="text-xs text-slate-400">Enter your Telegram phone number to receive a login code.</p>
                <div className="flex gap-2">
                  <input
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="+972527474425"
                    className="flex-1 bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={sendCode}
                    disabled={!phone.trim()}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-sm text-white transition-colors"
                  >
                    Send code
                  </button>
                </div>
                {authError && <p className="text-xs text-red-400">{authError}</p>}
              </>
            )}
            {authStep === 'sending' && (
              <p className="text-xs text-slate-400 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Sending code…</p>
            )}
            {(authStep === 'entering_code' || authStep === 'signing_in') && (
              <>
                <p className="text-xs text-slate-400">Enter the code Telegram sent to <span className="text-white">{phone}</span></p>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="12345"
                    className="w-28 bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 font-mono tracking-widest"
                  />
                  <input
                    value={twoFaPass}
                    onChange={e => setTwoFaPass(e.target.value)}
                    placeholder="2FA password (if enabled)"
                    type="password"
                    className="flex-1 bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={doSignIn}
                    disabled={!code.trim() || authStep === 'signing_in'}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-sm text-white transition-colors"
                  >
                    {authStep === 'signing_in' ? <Loader2 size={12} className="animate-spin" /> : 'Sign in'}
                  </button>
                </div>
                {authError && <p className="text-xs text-red-400">{authError}</p>}
              </>
            )}
          </div>
        )}
      </div>

      {/* Channel list */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2433]">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Channels ({sources.length})
          </span>
          <button
            onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Plus size={13} /> Add channel
          </button>
        </div>

        {showAdd && (
          <div className="p-4 border-b border-[#1e2433] bg-[#0a0f1e] space-y-3">
            <p className="text-xs text-slate-500">
              Enter the numeric channel ID (e.g. <code className="text-slate-300">-1001234567890</code>) or username (e.g. <code className="text-slate-300">@channelname</code>).
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newChannelId}
                onChange={e => setNewChannelId(e.target.value)}
                placeholder="Channel ID or @username"
                className="bg-[#0d1117] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <input
                value={newChannelName}
                onChange={e => setNewChannelName(e.target.value)}
                placeholder="Display name (optional)"
                className="bg-[#0d1117] border border-[#1e2433] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>Lookback:</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={newLookback}
                  onChange={e => setNewLookback(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 bg-[#0d1117] border border-[#1e2433] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <span>hours</span>
              </label>
              <button
                onClick={addChannel}
                disabled={adding || !newChannelId.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-sm text-white transition-colors"
              >
                {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add
              </button>
            </div>
            {addError && <p className="text-xs text-red-400">{addError}</p>}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-slate-500 text-sm flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : sources.length === 0 ? (
          <div className="p-8 text-center text-slate-600 text-sm">
            No channels yet. Add one above.
          </div>
        ) : (
          <div className="divide-y divide-[#1e2433]">
            {sources.map(src => (
              <div key={src.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[#0a0f1e] transition-colors">
                <StatusDot status={src.last_status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">
                    {src.name || src.channel_id}
                    {src.name && <span className="text-slate-600 font-mono text-[10px] ml-2">{src.channel_id}</span>}
                  </p>
                  <p className="text-[10px] text-slate-600">
                    Lookback {src.lookback_hours}h · Last: {fmt(src.last_fetched_at)}
                    {src.last_error && <span className="text-red-400 ml-2">{src.last_error.slice(0, 60)}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => fetchOne(src.id)}
                    disabled={fetchingOne === src.id || !authOk}
                    className="p-1.5 text-slate-500 hover:text-blue-400 transition-colors disabled:opacity-30"
                    title="Fetch now"
                  >
                    {fetchingOne === src.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  </button>
                  <button
                    onClick={() => toggleEnabled(src)}
                    className={clsx(
                      'text-[10px] px-2 py-0.5 rounded border transition-colors',
                      src.enabled
                        ? 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'
                        : 'border-slate-600 text-slate-500 hover:border-slate-400',
                    )}
                  >
                    {src.enabled ? 'enabled' : 'disabled'}
                  </button>
                  <button
                    onClick={() => deleteSource(src.id)}
                    className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-slate-600 space-y-1">
        <p>• Messages are fetched automatically with the RSS schedule (same interval).</p>
        <p>• Each message becomes an Article with <code className="text-slate-400">category=telegram</code> — fully searchable and analysable.</p>
        <p>• Deduplication is enforced: duplicate messages are never stored twice.</p>
        <p>• Set <code className="text-slate-400">telegram_api_id</code>, <code className="text-slate-400">telegram_api_hash</code> in <a href="/settings" className="text-blue-400 hover:underline">Settings</a>.</p>
      </div>
    </div>
  )
}
