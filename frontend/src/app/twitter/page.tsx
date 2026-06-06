'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Loader2, Trash2, ShieldCheck, AlertCircle, Plus, LogOut, Twitter, User, List, Search,
} from 'lucide-react'
import clsx from 'clsx'
import { twitterApi, type TwitterSource, type TwitterStatus } from '@/lib/api'

function fmt(s?: string): string {
  if (!s) return 'never'
  const ms = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? new Date(s).getTime() : new Date(s + 'Z').getTime()
  return new Date(ms).toLocaleString()
}

const KINDS = [
  { value: 'user', label: 'Account', icon: User, placeholder: 'username (without @)' },
  { value: 'list', label: 'List', icon: List, placeholder: 'list id' },
  { value: 'search', label: 'Search', icon: Search, placeholder: 'search query / #hashtag' },
] as const

export default function TwitterPage() {
  const [status, setStatus] = useState<TwitterStatus | null>(null)
  const [sources, setSources] = useState<TwitterSource[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchingOne, setFetchingOne] = useState<number | null>(null)
  const [fetchMsg, setFetchMsg] = useState('')
  const [error, setError] = useState('')

  // login form
  const [authMode, setAuthMode] = useState<'cookies' | 'password'>('cookies')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [ct0, setCt0] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  // add source form
  const [kind, setKind] = useState<'user' | 'list' | 'search'>('user')
  const [handle, setHandle] = useState('')
  const [lookback, setLookback] = useState(24)

  const authed = !!status?.authenticated

  const loadSources = useCallback(() => { twitterApi.list().then(setSources).catch(() => {}) }, [])
  const loadStatus = useCallback(() => {
    twitterApi.authStatus().then(setStatus).catch(() => setStatus({ authenticated: false, error: 'unreachable' }))
  }, [])

  useEffect(() => { loadStatus(); loadSources() }, [loadStatus, loadSources])

  async function doLogin() {
    if (!username.trim() || !password) return
    setLoggingIn(true); setError('')
    try {
      await twitterApi.login({ username: username.trim(), email: email.trim() || undefined, password, totp_secret: totp.trim() || undefined })
      setPassword(''); setTotp('')
      loadStatus()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Login failed')
    } finally { setLoggingIn(false) }
  }

  async function doCookieLogin() {
    if (!authToken.trim() || !ct0.trim()) return
    setLoggingIn(true); setError('')
    try {
      await twitterApi.loginWithCookies(authToken.trim(), ct0.trim())
      setAuthToken(''); setCt0('')
      loadStatus()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Cookie sign-in failed')
    } finally { setLoggingIn(false) }
  }

  async function doLogout() {
    try { await twitterApi.logout(); loadStatus() } catch {}
  }

  async function addSource() {
    const h = handle.trim()
    if (!h) return
    try {
      await twitterApi.create({ handle: h, kind, lookback_hours: lookback })
      setHandle('')
      loadSources()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not add source')
    }
  }

  async function toggleEnabled(s: TwitterSource) {
    try { const u = await twitterApi.update(s.id, { enabled: !s.enabled }); setSources(prev => prev.map(x => x.id === s.id ? u : x)) } catch {}
  }
  async function removeSource(id: number) {
    if (!window.confirm('Remove this source?')) return
    try { await twitterApi.remove(id); setSources(prev => prev.filter(x => x.id !== id)) } catch {}
  }

  async function fetchAll() {
    setFetching(true); setFetchMsg('')
    try {
      const r = await twitterApi.fetchAll()
      setFetchMsg(`${r.new_articles} new tweet${r.new_articles === 1 ? '' : 's'} from ${r.sources_fetched} source${r.sources_fetched === 1 ? '' : 's'}`)
      loadSources()
    } catch (e: unknown) {
      setFetchMsg(e instanceof Error ? e.message : 'Fetch failed')
    } finally { setFetching(false); setTimeout(() => setFetchMsg(''), 6000) }
  }
  async function fetchOne(id: number) {
    setFetchingOne(id)
    try { await twitterApi.fetchOne(id); loadSources() } catch {} finally { setFetchingOne(null) }
  }

  const curKind = KINDS.find(k => k.value === kind)!

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Twitter size={20} className="text-sky-400" /> Twitter / X
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Fetch posts from accounts, lists &amp; searches — stored as articles (category: twitter).
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={fetching || !authed}
          className="flex items-center gap-2 px-3 py-1.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors"
        >
          {fetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Fetch now
        </button>
      </div>
      {fetchMsg && <p className="text-xs text-sky-300 mb-4">{fetchMsg}</p>}

      {/* Auth */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 mb-6">
        {authed ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-sky-400 flex-1"><ShieldCheck size={16} /> Signed in to X</div>
            <button onClick={doLogout} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-red-400 border border-[#1e2433] hover:border-red-500/40 rounded-lg transition-colors">
              <LogOut size={12} /> Sign out
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button onClick={() => setAuthMode('cookies')} className={clsx('px-3 py-1.5 rounded-lg text-xs border transition-colors', authMode === 'cookies' ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-[#1e2433] text-slate-400 hover:text-white')}>Cookies (recommended)</button>
              <button onClick={() => setAuthMode('password')} className={clsx('px-3 py-1.5 rounded-lg text-xs border transition-colors', authMode === 'password' ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-[#1e2433] text-slate-400 hover:text-white')}>Username &amp; password</button>
            </div>

            {authMode === 'cookies' ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Paste your X session cookies (most reliable — X blocks automated password login via Cloudflare).</p>
                <input value={authToken} onChange={e => setAuthToken(e.target.value)} placeholder="auth_token cookie" className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50 font-mono" />
                <input value={ct0} onChange={e => setCt0(e.target.value)} placeholder="ct0 cookie" className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50 font-mono" />
                <p className="text-[10px] text-slate-600">
                  In your browser (logged in to x.com): DevTools → Application → Cookies → https://x.com → copy the
                  <span className="text-slate-400 font-mono"> auth_token</span> and <span className="text-slate-400 font-mono">ct0</span> values.
                </p>
                <button onClick={doCookieLogin} disabled={loggingIn || !authToken.trim() || !ct0.trim()} className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors">
                  {loggingIn ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Sign in with cookies
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Username &amp; password (used once — only the session is saved). Often blocked by X's Cloudflare; use cookies if it fails.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username (or @handle)" className="bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
                  <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (if asked)" className="bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" autoComplete="off" className="bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
                  <input value={totp} onChange={e => setTotp(e.target.value)} placeholder="2FA key (secret, not a code) — optional" className="bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
                </div>
                <button onClick={doLogin} disabled={loggingIn || !username.trim() || !password} className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-lg text-sm text-white font-medium transition-colors">
                  {loggingIn ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Sign in
                </button>
              </div>
            )}
            <p className="text-[10px] text-amber-400/70">Unofficial scraping — against X ToS; fetch sparingly to avoid rate limits.</p>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Add source */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Add source</h2>
        <div className="flex gap-2 mb-2 flex-wrap">
          {KINDS.map(k => (
            <button key={k.value} onClick={() => setKind(k.value)} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors', kind === k.value ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-[#1e2433] text-slate-400 hover:text-white')}>
              <k.icon size={12} /> {k.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={handle} onChange={e => setHandle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addSource() }} placeholder={curKind.placeholder} className="flex-1 min-w-[180px] bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
          <label className="flex items-center gap-1.5 text-xs text-slate-400">Lookback
            <input type="number" min={1} max={720} value={lookback} onChange={e => setLookback(Math.max(1, Math.min(720, parseInt(e.target.value) || 1)))} className="w-16 bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-sky-500/50" />h
          </label>
          <button onClick={addSource} disabled={!handle.trim()} className="flex items-center gap-1.5 px-3 py-2 bg-sky-600/20 border border-sky-500/30 text-sky-300 rounded-lg text-sm disabled:opacity-40 transition-colors"><Plus size={13} /> Add</button>
        </div>
      </div>

      {/* Sources */}
      <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1e2433]"><h2 className="text-sm font-semibold text-slate-300">Tracked sources ({sources.length})</h2></div>
        {sources.length === 0 ? (
          <p className="text-sm text-slate-500 p-4">No sources yet. Add an account, list, or search above.</p>
        ) : (
          <div className="divide-y divide-[#1e2433]">
            {sources.map(s => {
              const Icon = KINDS.find(k => k.value === s.kind)?.icon || User
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[#0a0f1e] transition-colors">
                  <Icon size={14} className="text-sky-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{s.kind === 'user' ? `@${s.handle}` : s.handle} <span className="text-[10px] text-slate-600 uppercase ml-1">{s.kind}</span></p>
                    <p className="text-[10px] text-slate-600">
                      {s.kind === 'user' && <><span className="text-slate-400 font-medium">{s.message_count.toLocaleString()}</span> tweets · </>}
                      Lookback {s.lookback_hours}h · Last: {fmt(s.last_fetched_at)}
                      {s.last_error && <span className="text-red-400 ml-2">{s.last_error.slice(0, 60)}</span>}
                    </p>
                  </div>
                  <button onClick={() => fetchOne(s.id)} disabled={fetchingOne === s.id || !authed} title="Fetch now" className="p-1.5 text-slate-500 hover:text-sky-400 transition-colors disabled:opacity-30">
                    {fetchingOne === s.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  </button>
                  <button onClick={() => toggleEnabled(s)} className={clsx('text-[10px] px-2 py-1 rounded border transition-colors', s.enabled ? 'border-sky-500/30 text-sky-300 bg-sky-500/10' : 'border-[#1e2433] text-slate-500')}>{s.enabled ? 'enabled' : 'disabled'}</button>
                  <button onClick={() => removeSource(s.id)} title="Remove" className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={13} /></button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
