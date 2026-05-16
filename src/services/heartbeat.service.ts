/// <reference types="chrome" />

/**
 * Heartbeat Service
 *
 * Manages WebSocket connections to the LifetimeSoft platform DO (Durable Object)
 * for each running agent. Mirrors what agent-runtime does in the Node.js host.
 *
 * Responsibilities:
 * - Open a WebSocket per running agent (keyed by run_id)
 * - Send heartbeat pings every 20s so the DO knows the agent is alive
 * - Relay incoming messages (trigger, config_updated) to the sandbox via background
 * - Reconnect automatically on disconnect
 * - Close connection when agent stops
 */

import { bgLog } from "../utils/logger"
import { getTokens } from "../storage/storage"
import { refreshTokenIfNeeded } from "./auth.service"
import { triggerAgent, applyConfigUpdate, resolvePendingJob } from "./runtime.service"
import { API_URLS, TIMING } from "../constants"
import type { HeartbeatConnection } from "../types"

// ─── Connection registry ──────────────────────────────────────────────────────
// run_id → HeartbeatConnection

const _connections = new Map<string, HeartbeatConnection>()

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a WebSocket heartbeat for the given agent run.
 * Safe to call multiple times — existing connection for the same run_id is reused.
 * @param wsUrl - WebSocket URL from ctx.meta.runtime.ws_url (falls back to default if omitted)
 */
export function startHeartbeat(agentName: string, runId: string, wsUrl?: string): Promise<void> {
  if (_connections.has(runId)) {
    bgLog.info(`Heartbeat already active for "${agentName}" (${runId})`)
    return Promise.resolve()
  }

  const resolvedWsUrl = wsUrl ?? API_URLS.WS_DEFAULT
  bgLog.info(`Starting heartbeat for "${agentName}" run_id=${runId} ws=${resolvedWsUrl}`)

  const conn: HeartbeatConnection = {
    ws:             null,
    heartbeatTimer: null,
    stopped:        false,
    agentName,
    wsUrl:          resolvedWsUrl,
  }
  _connections.set(runId, conn)

  // Return a promise that resolves once the WebSocket is open (or fails to connect).
  // Callers can await this to ensure the DO has an active connection before proceeding.
  return connectWithReady(runId, conn)
}

/**
 * Stop the WebSocket heartbeat for the given run_id.
 */
export function stopHeartbeat(runId: string): void {
  const conn = _connections.get(runId)
  if (!conn) return

  bgLog.info(`Stopping heartbeat for "${conn.agentName}" run_id=${runId}`)
  conn.stopped = true
  if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null }
  conn.ws?.close()
  _connections.delete(runId)
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Connect and return a Promise that resolves when the WebSocket is open,
 * or rejects after the first failed attempt (reconnects continue in background).
 */
async function connectWithReady(runId: string, conn: HeartbeatConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    void connectOnce(runId, conn, resolve)
  })
}

async function connectOnce(
  runId: string,
  conn: HeartbeatConnection,
  onReady: (() => void) | null
): Promise<void> {
  if (conn.stopped) { onReady?.(); return }

  // Refresh token if needed before creating WebSocket
  const tokenRefreshed = await refreshTokenIfNeeded()
  if (!tokenRefreshed) {
    bgLog.warn(`Heartbeat for "${conn.agentName}": token refresh failed — retrying in ${TIMING.RECONNECT_DELAY}ms`)
    onReady?.()
    setTimeout(() => { void connectOnce(runId, conn, null) }, TIMING.RECONNECT_DELAY)
    return
  }

  const { accessToken } = await getTokens()
  if (!accessToken) {
    bgLog.warn(`Heartbeat for "${conn.agentName}": no access token — retrying in ${TIMING.RECONNECT_DELAY}ms`)
    onReady?.()   // resolve anyway so startAgent() isn't blocked forever
    setTimeout(() => { void connectOnce(runId, conn, null) }, TIMING.RECONNECT_DELAY)
    return
  }

  const wsUrl = `${conn.wsUrl}?token=${encodeURIComponent(accessToken)}&run_id=${encodeURIComponent(runId)}`

  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl)
  } catch (e) {
    bgLog.error(`Heartbeat for "${conn.agentName}": failed to create WebSocket:`, String(e))
    onReady?.()
    setTimeout(() => { void connectOnce(runId, conn, null) }, TIMING.RECONNECT_DELAY)
    return
  }

  conn.ws = ws

  ws.addEventListener("open", () => {
    bgLog.info(`Heartbeat connected for "${conn.agentName}" run_id=${runId}`)
    onReady?.()   // WS is open — caller can now safely trigger

    conn.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type:      "heartbeat",
          run_id:    runId,
          status:    1,
          timestamp: Math.floor(Date.now() / 1000),
        }))
      }
    }, TIMING.HEARTBEAT_INTERVAL)
  })

  ws.addEventListener("message", (event: MessageEvent) => {
    handleMessage(conn.agentName, runId, event.data as string)
  })

  ws.addEventListener("close", (event: CloseEvent) => {
    if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null }
    // If WS closed before open fired, resolve so caller isn't blocked
    onReady?.()
    if (conn.stopped) return
    bgLog.info(`Heartbeat closed for "${conn.agentName}" (${event.code}) — reconnecting in ${TIMING.RECONNECT_DELAY}ms`)
    setTimeout(() => { void connectOnce(runId, conn, null) }, TIMING.RECONNECT_DELAY)
  })

  ws.addEventListener("error", () => {
    // error is always followed by close — reconnect handled there
  })
}

function handleMessage(agentName: string, runId: string, data: string): void {
  try {
    const msg = JSON.parse(data) as {
      type?: string
      config?: unknown
      job_id?: string
      image_url?: string | null
      success?: boolean
      message?: string | null
      [key: string]: unknown
    }

    if (msg.type === "trigger") {
      bgLog.info(`Heartbeat: trigger received for "${agentName}"`)
      triggerAgent(agentName).catch((e: unknown) => {
        bgLog.error(`Heartbeat: triggerAgent failed for "${agentName}":`, e instanceof Error ? e.message : String(e))
      })
    }

    if (msg.type === "config_updated") {
      bgLog.info(`Heartbeat: config_updated received for "${agentName}"`)
      applyConfigUpdate(agentName, msg.config as Record<string, unknown>).catch((e: unknown) => {
        bgLog.error(`Heartbeat: config update failed for "${agentName}":`, e instanceof Error ? e.message : String(e))
      })
    }

    if (msg.type === "image_ready" && msg.job_id) {
      bgLog.info(`Heartbeat: image_ready for job ${msg.job_id}`)
      resolvePendingJob("image", msg.job_id, msg.success ?? false, msg.image_url ?? null, msg.message ?? null)
    }

    if (msg.type === "video_ready" && msg.job_id) {
      bgLog.info(`Heartbeat: video_ready for job ${msg.job_id}`)
      resolvePendingJob("video", msg.job_id, msg.success ?? false, msg.image_url ?? null, msg.message ?? null)
    }

  } catch (e) {
    bgLog.error(`Heartbeat: failed to parse message for "${agentName}":`, e)
  }
}
