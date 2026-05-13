/// <reference types="chrome" />

/**
 * Sandbox Service
 *
 * Manages the Offscreen Document lifecycle and provides a clean API
 * for the background service worker to run agents inside the sandbox.
 *
 * Flow:
 *   background → ensureOffscreen() → offscreen doc → sandbox iframe → agent code
 *
 * The offscreen document hosts the sandboxed iframe and relays:
 *   - chrome.* proxy calls (storage, ai, queue)
 *   - log messages back to background
 *   - done/error signals back to background
 */

import { bgLog } from "../utils/logger"
import { createLogger } from "../utils/logger"
import { getTokens } from "../storage/storage"

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen/index.html")
const REGISTRY_BASE = "https://registry.lifetimesoft.com"

// ─── Offscreen document lifecycle ────────────────────────────────────────────

let _offscreenReady = false

async function ensureOffscreen(): Promise<void> {
  if (_offscreenReady) return

  const existing = await chrome.offscreen.hasDocument()
  if (!existing) {
    await chrome.offscreen.createDocument({
      url:    OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
      justification: "Host sandboxed iframe for running agent code dynamically",
    })
  }
  _offscreenReady = true
}

export async function closeOffscreen(): Promise<void> {
  if (!_offscreenReady) return
  await chrome.offscreen.closeDocument().catch(() => {})
  _offscreenReady = false
}

// ─── Agent bundle cache ───────────────────────────────────────────────────────
// Cache fetched bundles in memory to avoid re-fetching on every run

const _bundleCache = new Map<string, string>()

function bundleCacheKey(name: string, version: string): string {
  return `${name}@${version}`
}

async function fetchAgentBundle(name: string, version: string): Promise<string> {
  const key = bundleCacheKey(name, version)
  if (_bundleCache.has(key)) return _bundleCache.get(key)!

  const url = `${REGISTRY_BASE}/agents/${encodeURIComponent(name)}/${encodeURIComponent(version)}/bundle.js`
  bgLog.info(`Fetching agent bundle: ${url}`)

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch agent bundle "${name}@${version}" (${res.status})`)
  }

  const code = await res.text()
  _bundleCache.set(key, code)
  bgLog.info(`Agent bundle "${name}@${version}" cached (${code.length} bytes)`)
  return code
}

export function clearBundleCache(name?: string, version?: string): void {
  if (name && version) {
    _bundleCache.delete(bundleCacheKey(name, version))
  } else {
    _bundleCache.clear()
  }
}

// ─── Pending run callbacks ────────────────────────────────────────────────────
// requestId → { resolve, reject }

const _pendingRuns = new Map<string, {
  resolve: () => void
  reject:  (err: Error) => void
}>()

let _runSeq = 0
function nextRunId(): string { return `run_sb_${++_runSeq}` }

// ─── Handle messages from offscreen ──────────────────────────────────────────

export function handleOffscreenMessage(message: Record<string, unknown>): void {
  // Log from sandbox agent
  if (message.type === "offscreen_log") {
    const { agentName, level, args } = message as {
      agentName: string
      level:     "info" | "warn" | "error" | "debug"
      args:      string[]
    }
    const logger = createLogger(agentName as string)
    logger[level](...(args as unknown[]))
    return
  }

  // Agent run completed
  if (message.type === "offscreen_done") {
    const { requestId } = message as { requestId: string }
    const pending = _pendingRuns.get(requestId)
    if (pending) {
      _pendingRuns.delete(requestId)
      pending.resolve()
    }
    return
  }

  // Agent run errored
  if (message.type === "offscreen_error") {
    const { requestId, error } = message as { requestId: string; error: string }
    const pending = _pendingRuns.get(requestId)
    if (pending) {
      _pendingRuns.delete(requestId)
      pending.reject(new Error(error))
    }
    return
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SandboxRunOptions {
  agentName:   string
  agentVersion: string
  agentCtx:    object
}

/**
 * Run an agent inside the sandboxed iframe.
 * Fetches the bundle from the registry if not cached.
 * Returns a Promise that resolves when the agent's run() completes.
 */
export async function runInSandbox(options: SandboxRunOptions): Promise<void> {
  const { agentName, agentVersion, agentCtx } = options

  await ensureOffscreen()

  const code = await fetchAgentBundle(agentName, agentVersion)
  const { accessToken, refreshToken } = await getTokens()

  const requestId = nextRunId()

  return new Promise<void>((resolve, reject) => {
    _pendingRuns.set(requestId, { resolve, reject })

    // Timeout: 10 minutes max per run
    const timer = setTimeout(() => {
      if (_pendingRuns.has(requestId)) {
        _pendingRuns.delete(requestId)
        reject(new Error(`Agent "${agentName}" run timed out after 10 minutes`))
      }
    }, 10 * 60 * 1_000)

    // Wrap resolve/reject to clear timer
    const pending = _pendingRuns.get(requestId)!
    _pendingRuns.set(requestId, {
      resolve: () => { clearTimeout(timer); resolve() },
      reject:  (e) => { clearTimeout(timer); reject(e) },
    })

    chrome.runtime.sendMessage({
      type:         "offscreen_run",
      agentName,
      code,
      agentCtx,
      accessToken,
      refreshToken,
      requestId,
    }).catch((e: unknown) => {
      _pendingRuns.delete(requestId)
      clearTimeout(timer)
      reject(new Error(`Failed to send to offscreen: ${e instanceof Error ? e.message : String(e)}`))
    })
  })
}

/**
 * Stop a running agent in the sandbox.
 */
export async function stopInSandbox(agentName: string): Promise<void> {
  if (!_offscreenReady) return
  await chrome.runtime.sendMessage({ type: "offscreen_stop", agentName }).catch(() => {})
}
