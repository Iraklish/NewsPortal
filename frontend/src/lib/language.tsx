'use client'
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// Single source of truth for the languages the app can respond in.
// "English" is the no-op default (backend treats "" / "English" as "no change").
export const LANGUAGES = [
  'English', 'Hebrew', 'Russian', 'Georgian', 'French', 'German', 'Arabic', 'Spanish',
] as const
export type Lang = typeof LANGUAGES[number]

const STORAGE_KEY = 'newsportal.language'

interface LanguageCtx {
  language: Lang
  setLanguage: (l: Lang) => void
  /** undefined when English (so callers can omit it), otherwise the language name. */
  apiLanguage: string | undefined
}

const Ctx = createContext<LanguageCtx | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Lang>('English')

  // Hydrate from localStorage on mount (client-only — avoids SSR mismatch).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved && (LANGUAGES as readonly string[]).includes(saved)) {
        setLanguageState(saved as Lang)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const setLanguage = (l: Lang) => {
    setLanguageState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* ignore */
    }
  }

  const apiLanguage = language !== 'English' ? language : undefined

  return <Ctx.Provider value={{ language, setLanguage, apiLanguage }}>{children}</Ctx.Provider>
}

export function useLanguage(): LanguageCtx {
  const ctx = useContext(Ctx)
  if (!ctx) {
    // Safe fallback if used outside the provider — behaves as English.
    return { language: 'English', setLanguage: () => {}, apiLanguage: undefined }
  }
  return ctx
}
