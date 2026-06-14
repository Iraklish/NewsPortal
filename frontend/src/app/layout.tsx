import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import AppShell from '@/components/AppShell'
import ErrorLoggerBoot from '@/components/ErrorLoggerBoot'
import { LanguageProvider } from '@/lib/language'
import { FontSizeProvider } from '@/lib/fontsize'
import { AuthProvider } from '@/lib/auth'
import { SidebarProvider } from '@/lib/sidebar'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'NewsPortal',
  description: 'Global News Intelligence Dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className} style={{ background: '#0a0f1e' }}>
        <ErrorLoggerBoot />
        <AuthProvider>
          <LanguageProvider>
            <FontSizeProvider>
              <SidebarProvider>
                <AppShell>{children}</AppShell>
              </SidebarProvider>
            </FontSizeProvider>
          </LanguageProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
