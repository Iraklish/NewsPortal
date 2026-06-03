'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Lock, User as UserIcon, Eye, EyeOff } from 'lucide-react'
import { authApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'

export default function SignInPage() {
  const router = useRouter()
  const { user, ready, login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Already signed in → leave the sign-in page.
  useEffect(() => {
    if (ready && user) router.replace('/')
  }, [ready, user, router])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await authApi.login(username.trim(), password)
      login(res)
      router.replace('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#0a0f1e' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/40 mb-3">
            <Lock size={20} className="text-indigo-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">NewsPortal</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to continue</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-[#0d1117] border border-[#1e2433] rounded-2xl p-6 shadow-2xl space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Username</label>
            <div className="relative">
              <UserIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="Your username"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="Your password"
              />
              <button
                type="button"
                onClick={() => setShowPw(s => !s)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
                tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm text-white font-semibold transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
            Sign in
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-4">
          Accounts are created by an administrator.
        </p>
      </div>
    </div>
  )
}
