import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Sidebar from '@/components/Sidebar'
import ErrorLoggerBoot from '@/components/ErrorLoggerBoot'

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
        <Sidebar />
        <main className="ml-64 min-h-screen p-6">
          {children}
        </main>
      </body>
    </html>
  )
}
