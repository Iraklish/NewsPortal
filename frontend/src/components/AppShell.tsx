'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import { useAuth } from '@/lib/auth'
import { useSidebar } from '@/lib/sidebar'

/**
 * Auth gate + app chrome.
 *
 * - On the /signin route: render the page bare (no sidebar), regardless of auth.
 * - Everywhere else: require an authenticated user. While the initial token
 *   check is in flight, show a spinner; if unauthenticated, redirect to /signin.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth()
  const { collapsed } = useSidebar()
  const pathname = usePathname()
  const router = useRouter()
  const isSignin = pathname === '/signin'

  useEffect(() => {
    if (ready && !user && !isSignin) {
      router.replace('/signin')
    }
  }, [ready, user, isSignin, router])

  // The sign-in page renders without the app chrome.
  if (isSignin) return <>{children}</>

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-indigo-400" size={28} />
      </div>
    )
  }

  // Redirect effect is in flight — render nothing to avoid a flash of content.
  if (!user) return null

  return (
    <>
      <Sidebar />
      <main className={[collapsed ? 'md:ml-16' : 'md:ml-64', 'min-h-screen p-4 md:p-6 pt-16 md:pt-6 transition-[margin] duration-200'].join(' ')}>
        {children}
      </main>
    </>
  )
}
