/// <reference types="chrome" />

/**
 * Persistent per-agent logger for Chrome Extension Host.
 *
 * Design:
 * - Circular buffer: max LOG_MAX_ENTRIES entries, oldest dropped automatically
 * - Message truncation: each msg capped at MSG_MAX_CHARS to prevent bloat
 * - Write queue: serialises all writes to avoid read-modify-write race conditions
 * - Storage key: "lts_logs_{agentName}"  →  LogEntry[]  (newest last)
 *
 * Worst-case storage size per agent:
 *   LOG_MAX_ENTRIES(100) × (MSG_MAX_CHARS(300) + ~50 overhead) ≈ 35KB
 *   Well within chrome.storage.local 10MB limit.
 */

import { agentLogKey } from "../storage/storage"

export type LogLevel = "info" | "warn" | "error" | "debug"

export interface LogEntry {
  ts:    number    // unix ms
  level: LogLevel
  tag:   string    // e.g. "[background]", "[agent:hello-world]"
  msg:   string    // truncated to MSG_MAX_CHARS
}

const LOG_MAX_ENTRIES = 100   // keep last N entries per agent
const MSG_MAX_CHARS   = 300   // truncate long messages

// ─── Per-agent write queues ───────────────────────────────────────────────────
// Each agent gets its own serialised write queue to prevent race conditions.

const _writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(storageKey: string, entry: LogEntry): void {
  const prev = _writeQueues.get(storageKey) ?? Promise.resolve()
  const next = prev.then(async () => {
    try {
      const stored = await chrome.storage.local.get(storageKey)
      const entries: LogEntry[] = (stored[storageKey] as LogEntry[] | undefined) ?? []

      entries.push(entry)

      // trim to cap — splice from front (oldest first)
      if (entries.length > LOG_MAX_ENTRIES) {
        entries.splice(0, entries.length - LOG_MAX_ENTRIES)
      }

      await chrome.storage.local.set({ [storageKey]: entries })
    } catch {
      // storage write failed — don't crash the agent
    }
  }).catch(() => {
    // reset queue on unexpected error so future writes aren't blocked
    _writeQueues.delete(storageKey)
  })
  _writeQueues.set(storageKey, next)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEntry(level: LogLevel, tag: string, args: unknown[]): LogEntry {
  let msg = args
    .map(a => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
    .join(" ")

  if (msg.length > MSG_MAX_CHARS) {
    msg = msg.slice(0, MSG_MAX_CHARS) + "…"
  }

  return { ts: Date.now(), level, tag, msg }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function clearAgentLogs(agentName: string): Promise<void> {
  await chrome.storage.local.set({ [agentLogKey(agentName)]: [] })
}

export async function getAgentLogs(agentName: string): Promise<LogEntry[]> {
  const key = agentLogKey(agentName)
  const stored = await chrome.storage.local.get(key)
  return (stored[key] as LogEntry[] | undefined) ?? []
}

export async function getAllLogs(): Promise<Record<string, LogEntry[]>> {
  // Get all keys from storage and filter for log keys
  const all = await chrome.storage.local.get(null)
  const result: Record<string, LogEntry[]> = {}
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("lts_logs_")) {
      const agentName = key.slice("lts_logs_".length)
      result[agentName] = (value as LogEntry[] | undefined) ?? []
    }
  }
  return result
}

/**
 * Create a logger for a specific agent.
 * Writes to both console and chrome.storage.local under lts_logs_{agentName}.
 * Safe to call concurrently — writes are serialised internally per agent.
 */
export function createLogger(agentName: string) {
  const storageKey = agentLogKey(agentName)
  const tag = `[${agentName}]`

  return {
    info:  (...args: unknown[]) => { console.log(tag, ...args);   enqueueWrite(storageKey, buildEntry("info",  tag, args)) },
    warn:  (...args: unknown[]) => { console.warn(tag, ...args);  enqueueWrite(storageKey, buildEntry("warn",  tag, args)) },
    error: (...args: unknown[]) => { console.error(tag, ...args); enqueueWrite(storageKey, buildEntry("error", tag, args)) },
    debug: (...args: unknown[]) => { console.debug(tag, ...args); enqueueWrite(storageKey, buildEntry("debug", tag, args)) },
  }
}

// Background logger (not per-agent — uses a special "background" agent name)
export const bgLog = createLogger("background")
