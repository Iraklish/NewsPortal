'use client'
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'

// Global UI font scaling. We set the root <html> font-size; because the app's
// Tailwind sizing/spacing is rem-based, this scales the whole UI (zoom-like),
// not just text. Persisted in localStorage.

const STORAGE_KEY = 'newsportal.fontScale'
const BASE_PX = 16
const MIN = 80
const MAX = 160
const STEP = 10

interface FontSizeCtx {
  scale: number              // percent, 100 = default
  setScale: (s: number) => void
  increase: () => void
  decrease: () => void
  reset: () => void
  canIncrease: boolean
  canDecrease: boolean
}

const Ctx = createContext<FontSizeCtx | null>(null)

function apply(scale: number) {
  if (typeof document !== 'undefined') {
    document.documentElement.style.fontSize = `${(BASE_PX * scale) / 100}px`
  }
}

export function FontSizeProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(100)

  // Hydrate from localStorage on mount (client-only — avoids SSR mismatch).
  useEffect(() => {
    try {
      const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10)
      if (!isNaN(saved) && saved >= MIN && saved <= MAX) {
        setScaleState(saved)
        apply(saved)
        return
      }
    } catch {
      /* ignore */
    }
    apply(100)
  }, [])

  const setScale = useCallback((s: number) => {
    const clamped = Math.max(MIN, Math.min(MAX, Math.round(s / STEP) * STEP))
    setScaleState(clamped)
    apply(clamped)
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }, [])

  const increase = useCallback(() => setScale(scale + STEP), [scale, setScale])
  const decrease = useCallback(() => setScale(scale - STEP), [scale, setScale])
  const reset = useCallback(() => setScale(100), [setScale])

  return (
    <Ctx.Provider
      value={{ scale, setScale, increase, decrease, reset, canIncrease: scale < MAX, canDecrease: scale > MIN }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useFontSize(): FontSizeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) {
    return {
      scale: 100, setScale: () => {}, increase: () => {}, decrease: () => {},
      reset: () => {}, canIncrease: true, canDecrease: true,
    }
  }
  return ctx
}
