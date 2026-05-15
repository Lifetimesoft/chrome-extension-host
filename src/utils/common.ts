/**
 * Common utility functions
 */

import { STORAGE_KEYS, ALARMS } from "../constants"

/**
 * Generate a random job ID (6 hex characters)
 */
export function generateJobId(): string {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")
}

/**
 * Format date like agent-sdk (YYYY-MM-DD HH:mm:ss)
 */
export function formatDate(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}

/**
 * Generate storage key for agent logs
 */
export function agentLogKey(agentName: string): string {
  return `${STORAGE_KEYS.AGENT_LOGS_PREFIX}${agentName}`
}

/**
 * Generate storage key for agent context
 */
export function agentCtxKey(agentName: string): string {
  return `${STORAGE_KEYS.AGENT_CTX_PREFIX}${agentName}`
}

/**
 * Generate alarm name for agent scheduler
 */
export function schedulerAlarmName(agentName: string): string {
  return `${ALARMS.SCHEDULER_PREFIX}${agentName}`
}

/**
 * Extract agent name from scheduler alarm name
 */
export function agentNameFromAlarm(alarmName: string): string | null {
  if (!alarmName.startsWith(ALARMS.SCHEDULER_PREFIX)) return null
  return alarmName.replace(ALARMS.SCHEDULER_PREFIX, "")
}

/**
 * Check if a JWT token is expired
 */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
    return Math.floor(Date.now() / 1000) >= (payload.exp as number)
  } catch {
    return true
  }
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Create an AbortSignal that aborts when any of the provided signals abort
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller.signal
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      if (attempt === maxAttempts) {
        throw lastError
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1)
      await sleep(delay)
    }
  }
  
  throw lastError!
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>
  
  return (...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean
  
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args)
      inThrottle = true
      setTimeout(() => inThrottle = false, limit)
    }
  }
}