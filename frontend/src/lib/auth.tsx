'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import {
  authApi,
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  type AuthUser,
  type LoginResponse,
} from './api'

interface AuthContextValue {
  user: AuthUser | null
  ready: boolean          // initial token check has completed
  login: (res: LoginResponse) => void
  logout: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    if (!getAuthToken()) { setUser(null); return }
    try {
      const u = await authApi.me()
      setUser(u)
    } catch {
      clearAuthToken()
      setUser(null)
    }
  }, [])

  useEffect(() => {
    refresh().finally(() => setReady(true))
  }, [refresh])

  const login = useCallback((res: LoginResponse) => {
    setAuthToken(res.access_token)
    setUser(res.user)
  }, [])

  const logout = useCallback(() => {
    clearAuthToken()
    setUser(null)
    if (typeof window !== 'undefined') window.location.href = '/signin'
  }, [])

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
