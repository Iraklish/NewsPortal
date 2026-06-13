'use client'
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'

// Whether the desktop sidebar is collapsed to an icon-only rail. Persisted
// in localStorage; mobile always uses the full-width overlay drawer.

const STORAGE_KEY = 'newsportal.sidebarCollapsed'

interface SidebarCtx {
  collapsed: boolean
  toggle: () => void
}

const Ctx = createContext<SidebarCtx | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true)
    } catch {
      /* ignore */
    }
  }, [])

  const toggle = useCallback(() => {
    setCollapsed(v => {
      const next = !v
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  return <Ctx.Provider value={{ collapsed, toggle }}>{children}</Ctx.Provider>
}

export function useSidebar(): SidebarCtx {
  const ctx = useContext(Ctx)
  if (!ctx) return { collapsed: false, toggle: () => {} }
  return ctx
}
