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

const DEFAULT_WS_URL      = "wss://app.lifetimesoft.com/cli/ai-account-management/agents/ws"
const HEARTBEAT_INTERVAL  = 20_000   // 20s — matches Node.js runtime
const RECONNECT_DELAY     = 5_000    // 5s

// ─── Connection registry ──────────────────────────────────────────────────────
// run_id → HeartbeatConnection

interface HeartbeatConnection {
  ws:              WebSocket | null
  heartbeatTimer:  ReturnType<typeof setInterval> | null
  stopped:         boolean
  agentName:       string
  wsUrl:           string
}

const _connections = new Map<string, HeartbeatConnection>()

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a WebSocket heartbeat for the given agent run.
 * Safe to call multiple times — existing connection for the same run_id is reused.
 * @param wsUrl - WebSocket URL from ctx.meta.runtime.ws_url (falls back to default if omitted)
 */
export function startHeartbeat(agentName: string, runId: string, wsUrl?: string): void {
  if (_connections.has(runId)) {
    bgLog.info(`Heartbeat already active for "${agentName}" (${runId})`)
    return
  }

  const resolvedWsUrl = wsUrl ?? DEFAULT_WS_URL
  bgLog.info(`Starting heartbeat for "${agentName}" run_id=${runId} ws=${resolvedWsUrl}`)

  const conn: HeartbeatConnection = {
    ws:             null,
    heartbeatTimer: null,
    stopped:        false,
    agentName,
    wsUrl:          resolvedWsUrl,
  }
  _connections.set(runId, conn)

  void connect(runId, conn)
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

async function connect(runId: string, conn: HeartbeatConnection): Promise<void> {
  if (conn.stopped) return

  const { accessToken } = await getTokens()
  if (!accessToken) {
    bgLog.warn(`Heartbeat for "${conn.agentName}": no access token — retrying in ${RECONNECT_DELAY}ms`)
    setTimeout(() => { void connect(runId, conn) }, RECONNECT_DELAY)
    return
  }

  const wsUrl = `${conn.wsUrl}?token=${encodeURIComponent(accessToken)}&run_id=${encodeURIComponent(runId)}`

  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl)
  } catch (e) {
    bgLog.error(`Heartbeat for "${conn.agentName}": failed to create WebSocket:`, String(e))
    setTimeout(() => { void connect(runId, conn) }, RECONNECT_DELAY)
    return
  }

  conn.ws = ws

  ws.addEventListener("open", () => {
    bgLog.info(`Heartbeat connected for "${conn.agentName}" run_id=${runId}`)

    conn.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type:      "heartbeat",
          run_id:    runId,
          status:    1,
          timestamp: Math.floor(Date.now() / 1000),
        }))
      }
    }, HEARTBEAT_INTERVAL)
  })

  ws.addEventListener("message", (event: MessageEvent) => {
    handleMessage(conn.agentName, runId, event.data as string)
  })

  ws.addEventListener("close", (event: CloseEvent) => {
    if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null }
    if (conn.stopped) return
    bgLog.info(`Heartbeat closed for "${conn.agentName}" (${event.code}) — reconnecting in ${RECONNECT_DELAY}ms`)
    setTimeout(() => { void connect(runId, conn) }, RECONNECT_DELAY)
  })

  ws.addEventListener("error", () => {
    // error is always followed by close — reconnect handled there
  })
}

function handleMessage(agentName: string, runId: string, data: string): void {
  try {
    const msg = JSON.parse(data) as { type?: string; [key: string]: unknown }

    if (msg.type === "trigger") {
      bgLog.info(`Heartbeat: trigger received for "${agentName}"`)
      // Forward to background to re-run the agent in sandbox
      chrome.runtime.sendMessage({
        type:      "heartbeat_trigger",
        agentName,
        runId,
      }).catch(() => { /* background may not be listening */ })
    }

    if (msg.type === "config_updated") {
      bgLog.info(`Heartbeat: config_updated received for "${agentName}"`)
      chrome.runtime.sendMessage({
        type:      "heartbeat_config_updated",
        agentName,
        runId,
        config:    msg.config,
      }).catch(() => {})
    }

  } catch {
    // ignore malformed messages
  }
}
