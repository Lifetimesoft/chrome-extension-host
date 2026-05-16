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
import { API_URLS } from "../constants"
import type { SandboxRunOptions, PendingRun } from "../types"
import { generateJobId, formatDate } from "../utils/common"

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen/index.html")

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

export async function ensureOffscreenAlive(): Promise<void> {
  await ensureOffscreen()
}

export async function closeOffscreen(): Promise<void> {
  if (!_offscreenReady) return
  await chrome.offscreen.closeDocument().catch(() => {})
  _offscreenReady = false
}

// ─── Keepalive control ────────────────────────────────────────────────────────

/** Tell offscreen to start pinging SW every 20s — call when first agent starts */
export function notifyOffscreenKeepaliveStart(): void {
  if (!_offscreenReady) return
  chrome.runtime.sendMessage({ type: "offscreen_keepalive_start" }).catch(() => {})
}

/** Tell offscreen to stop pinging SW — call when last agent stops */
export function notifyOffscreenKeepaliveStop(): void {
  if (!_offscreenReady) return
  chrome.runtime.sendMessage({ type: "offscreen_keepalive_stop" }).catch(() => {})
}

// ─── Agent bundle cache ───────────────────────────────────────────────────────
// Cache fetched bundles in memory to avoid re-fetching on every run

const _bundleCache = new Map<string, string>()

function bundleCacheKey(name: string, version: string): string {
  return `${name}@${version}`
}

async function fetchAgentBundle(name: string, version: string, devBundleUrl?: string): Promise<string> {
  // Dev mode: fetch directly from local URL, skip cache so every run gets latest code
  if (devBundleUrl) {
    bgLog.info(`[dev] Fetching agent bundle "${name}" from ${devBundleUrl}`)
    const res = await fetch(devBundleUrl, { cache: "no-store" })
    if (!res.ok) throw new Error(`[dev] Failed to fetch bundle from ${devBundleUrl} (${res.status})`)
    const code = await res.text()
    bgLog.info(`[dev] Bundle loaded (${code.length} bytes) — not cached`)
    return code
  }

  const key = bundleCacheKey(name, version)
  if (_bundleCache.has(key)) return _bundleCache.get(key)!

  bgLog.info(`Fetching agent bundle "${name}@${version}" from registry...`)

  const { accessToken } = await getTokens()
  if (!accessToken) throw new Error("Not logged in — cannot fetch agent bundle")

  // Pull the tar.gz from the registry API
  const res = await fetch(`${API_URLS.AGENT_BASE}/agents/pull`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  accessToken,
    },
    body: JSON.stringify({ name, version }),
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => "unknown error")
    throw new Error(`Failed to fetch agent bundle "${name}@${version}" (${res.status}): ${msg}`)
  }

  // Decompress gzip → tar → extract dist/index.js using browser-native APIs
  const tarBuffer = await decompressGzip(await res.arrayBuffer())
  const code = extractFileFromTar(tarBuffer, "dist/index.js")

  if (!code) {
    throw new Error(`Agent bundle "${name}@${version}" does not contain dist/index.js`)
  }

  _bundleCache.set(key, code)
  bgLog.info(`Agent bundle "${name}@${version}" cached (${code.length} bytes)`)
  return code
}

/**
 * Decompress a gzip ArrayBuffer using the browser-native DecompressionStream API.
 */
async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("gzip")
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()

  writer.write(compressed)
  writer.close()

  const chunks: Uint8Array[] = []
  let totalLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLength += value.length
  }

  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result.buffer
}

/**
 * Extract a specific file from a tar archive (uncompressed).
 * Returns the file content as a UTF-8 string, or null if not found.
 *
 * Tar format: 512-byte header blocks followed by file data padded to 512-byte blocks.
 */
function extractFileFromTar(tarBuffer: ArrayBuffer, targetPath: string): string | null {
  const view   = new Uint8Array(tarBuffer)
  const dec    = new TextDecoder("utf-8")
  let   offset = 0

  while (offset + 512 <= view.length) {
    // Read filename from header (bytes 0–99, null-terminated)
    const nameBytes = view.slice(offset, offset + 100)
    const nameEnd   = nameBytes.indexOf(0)
    const name      = dec.decode(nameBytes.slice(0, nameEnd < 0 ? 100 : nameEnd)).trim()

    // Read file size from header (bytes 124–135, octal ASCII)
    const sizeOctal = dec.decode(view.slice(offset + 124, offset + 136)).trim().replace(/\0/g, "")
    const fileSize  = parseInt(sizeOctal, 8) || 0

    // Empty header = end of archive
    if (!name) break

    const dataOffset = offset + 512

    // Normalise path: strip leading "./" or "/"
    const normName = name.replace(/^\.\//, "").replace(/^\//, "")

    if (normName === targetPath && fileSize > 0) {
      return dec.decode(view.slice(dataOffset, dataOffset + fileSize))
    }

    // Advance to next header (data padded to 512-byte boundary)
    offset = dataOffset + Math.ceil(fileSize / 512) * 512
  }

  return null
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

const _pendingRuns = new Map<string, PendingRun>()

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
    // Use raw console output since sandbox already formats with [job:xxx] prefix
    const logger = createLogger(agentName as string)
    if (level === "warn") {
      // Map warn to info since bgLog doesn't have warn
      logger.info(...(args as unknown[]))
    } else {
      logger[level as "info" | "error" | "debug"](...(args as unknown[]))
    }
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

/**
 * Run an agent inside the sandboxed iframe.
 * Fetches the bundle from the registry if not cached.
 * Returns a Promise that resolves when the agent's run() completes.
 */
export async function runInSandbox(options: SandboxRunOptions): Promise<void> {
  const { agentName, agentVersion, agentCtx } = options

  await ensureOffscreen()

  // Check for dev bundle URL in chrome.storage.local — set via dashboard Dev panel
  const devStored = await chrome.storage.local.get(`lts_dev_bundle_${agentName}`)
  const devBundleUrl = (devStored[`lts_dev_bundle_${agentName}`] as string | undefined) || undefined
  const code = await fetchAgentBundle(agentName, agentVersion, devBundleUrl)
  const { accessToken, refreshToken } = await getTokens()

  const requestId = nextRunId()
  const jobId = generateJobId()

  // Don't log start/end here - let sandbox handle it

  return new Promise<void>((resolve, reject) => {
    _pendingRuns.set(requestId, { 
      resolve: () => {
        // Don't log end here - sandbox already logged it
        resolve()
      }, 
      reject: (e) => {
        bgLog.error(`[${formatDate()}] [job:${jobId}] [agent:error] job failed:`, e.message)
        bgLog.info(`[${formatDate()}] [job:${jobId}] [agent:info] ----------`)
        reject(e)
      }
    })

    // Timeout: 10 minutes max per run
    const timer = setTimeout(() => {
      if (_pendingRuns.has(requestId)) {
        _pendingRuns.delete(requestId)
        bgLog.error(`[${formatDate()}] [job:${jobId}] [agent:error] job timed out after 10 minutes`)
        bgLog.info(`[${formatDate()}] [job:${jobId}] [agent:info] ----------`)
        reject(new Error(`Agent "${agentName}" run timed out after 10 minutes`))
      }
    }, 10 * 60 * 1_000)

    // Wrap resolve/reject to clear timer
    const pending = _pendingRuns.get(requestId)!
    _pendingRuns.set(requestId, {
      resolve: () => { clearTimeout(timer); pending.resolve() },
      reject:  (e) => { clearTimeout(timer); pending.reject(e) },
    })

    chrome.runtime.sendMessage({
      type:         "offscreen_run",
      agentName,
      code,
      agentCtx,
      accessToken,
      refreshToken,
      requestId,
      jobId,  // Send jobId to sandbox
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
