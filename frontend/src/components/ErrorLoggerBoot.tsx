'use client'
import { useEffect } from 'react'
import { installClientErrorLogger } from '@/lib/error-logger'

export default function ErrorLoggerBoot() {
  useEffect(() => { installClientErrorLogger() }, [])
  return null
}
