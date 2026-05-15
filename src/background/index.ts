/// <reference types="chrome" />

/**
 * Background Service Worker (MV3) — Host Entry Point
 *
 * Acts like Docker Desktop or Steam: manages multiple agent runtimes.
 * On install/wake: bootstraps all previously-running agents.
 * Handles messages from popup and dashboard.
 */

import { bgLog } from "../utils/logger"
import { login, logout, cancelLogin, isLoggedIn, resumeLoginIfPending } from "../services/auth.service"
import { listInstalledAgents, installAgent, uninstallAgent, updateAgentConfig } from "../services/agent.service"
import { startAgent, stopAgent, isAgentRunning, triggerAgent, applyConfigUpdate, reconnectHeartbeats, restoreAgent, forceStopIfRunning } from "../services/runtime.service"
import { handleOffscreenMessage, ensureOffscreenAlive } from "../services/sandbox.service"
import { getTokens } from "../storage/storage"

const APP_BASE = "https://app.lifetimesoft.com/cli/ai-account-management"

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Guard against concurrent bootstrap calls — MV3 SW can wake up multiple times
// in quick succession (e.g. install event + top-level wake + incoming message)
let _bootstrapping = false

async function bootstrap(): Promise<void> {
  if (_bootstrapping) return
  _bootstrapping = true

  try {
    bgLog.info("Host bootstrapping...")

    // Resume login polling if SW was terminated during a login flow
    await resumeLoginIfPending()

    const loggedIn = await isLoggedIn()
    if (!loggedIn) {
      bgLog.info("Not logged in — waiting for user to authenticate via popup")
      return
    }

    const agents = await listInstalledAgents()
    // Only restore agents that are marked running AND not already running in memory.
    // This prevents double-start when SW wakes up due to an incoming message
    // (e.g. heartbeat_trigger) while a previous bootstrap already started the agent.
    const toRestore = agents.filter(a => a.status === "running" && !isAgentRunning(a.name))

    if (toRestore.length === 0) {
      bgLog.info("No previously running agents to restore")
      return
    }

    bgLog.info(`Restoring ${toRestore.length} previously running agent(s)...`)

    // Ensure offscreen document is alive so keepalive pings keep the SW active
    await ensureOffscreenAlive()

    for (const agent of toRestore) {
      try {
        // Use reconnectHeartbeats-style restore: load ctx from storage and reconnect WS.
        // Only fall back to full startAgent() if ctx is missing from storage.
        // This avoids calling /agents/restart on every SW wake-up.
        await restoreAgent(agent.name)
        bgLog.info(`Restored agent "${agent.name}"`)
      } catch (e) {
        bgLog.error(`Failed to restore agent "${agent.name}":`, e instanceof Error ? e.message : String(e))
      }
    }
  } finally {
    _bootstrapping = false
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return undefined

  // ── Auth: login ──
  if (message.type === "auth_login") {
    login()
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Auth: cancel login ──
  if (message.type === "auth_login_cancel") {
    cancelLogin()
    sendResponse({ success: true })
    return undefined
  }

  // ── Auth: logout ──
  if (message.type === "auth_logout") {
    const doLogout = async () => {
      // Stop all running agents before logging out
      const agents = await listInstalledAgents()
      for (const agent of agents) {
        if (isAgentRunning(agent.name)) {
          await stopAgent(agent.name).catch(() => { /* best-effort */ })
        }
      }
      await logout()
    }

    doLogout()
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: true })) // always succeed locally
    return true
  }

  // ── Agent: start ──
  if (message.type === "agent_start") {
    const { name } = message as { name: string }
    startAgent(name)
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Agent: stop ──
  if (message.type === "agent_stop") {
    const { name } = message as { name: string }
    stopAgent(name)
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Agent: install ──
  if (message.type === "agent_install") {
    const { name, version, config } = message as {
      name: string
      version: string
      config?: Record<string, unknown>
    }
    installAgent(name, version, config)
      .then(agent => sendResponse({ success: true, agent }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Agent: uninstall ──
  if (message.type === "agent_uninstall") {
    const { name } = message as { name: string }
    const doUninstall = async () => {
      // Stop runtime if running in memory
      if (isAgentRunning(name)) {
        await stopAgent(name)
      } else {
        // SW may have restarted — check storage status and stop heartbeat + notify platform
        // even if _running map is empty
        await forceStopIfRunning(name)
      }
      await uninstallAgent(name)
    }
    doUninstall()
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Runtime: disconnect (stop without logout) ──
  if (message.type === "runtime_disconnect") {
    const { name } = message as { name?: string }
    const doDisconnect = async () => {
      if (name) {
        await stopAgent(name)
      } else {
        // Stop all agents
        const agents = await listInstalledAgents()
        for (const agent of agents) {
          if (isAgentRunning(agent.name)) {
            await stopAgent(agent.name).catch(() => { /* best-effort */ })
          }
        }
      }
    }
    doDisconnect()
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: true }))
    return true
  }

  // ── Runtime: reconnect (restart without re-login) ──
  if (message.type === "runtime_reconnect") {
    const { name } = message as { name?: string }
    const doReconnect = async () => {
      if (name) {
        await startAgent(name)
      } else {
        // Restart all installed agents that were running
        const agents = await listInstalledAgents()
        for (const agent of agents.filter(a => a.status === "running")) {
          await startAgent(agent.name).catch((e: unknown) => {
            bgLog.error(`Failed to reconnect agent "${agent.name}":`, e instanceof Error ? e.message : String(e))
          })
        }
      }
    }
    doReconnect()
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Status: get current state ──
  if (message.type === "get_status") {
    const getStatus = async () => {
      const loggedIn = await isLoggedIn()
      const agents = await listInstalledAgents()
      // Sync in-memory running state with stored state
      const agentsWithLiveStatus = agents.map(a => ({
        ...a,
        status: isAgentRunning(a.name) ? "running" as const : a.status,
      }))
      return { loggedIn, agents: agentsWithLiveStatus }
    }
    getStatus()
      .then(status => sendResponse(status))
      .catch(() => sendResponse({ loggedIn: false, agents: [] }))
    return true
  }

  // ── Navigation: open dashboard ──
  if (message.type === "open_dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  // ── Navigation: open logs ──
  if (message.type === "open_logs") {
    const { agent } = message as { agent?: string }
    const url = chrome.runtime.getURL("logs/index.html") + (agent ? `?agent=${encodeURIComponent(agent)}` : "")
    chrome.tabs.create({ url })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  // ── Offscreen: relay messages from offscreen document (sandbox logs/done/error) ──
  if (
    message.type === "offscreen_log"   ||
    message.type === "offscreen_done"  ||
    message.type === "offscreen_error"
  ) {
    handleOffscreenMessage(message as Record<string, unknown>)
    sendResponse({ success: true })
    return undefined
  }

  // ── Offscreen: keepalive ping — resets SW idle timer so WS stays connected ──
  if (message.type === "offscreen_keepalive") {
    // No-op — receiving this message is enough to reset the SW idle timer
    sendResponse({ success: true })
    return undefined
  }

  // ── Heartbeat: trigger from DO (scheduler type: none) — run agent in sandbox in-process ──
  if (message.type === "heartbeat_trigger") {
    const { agentName } = message as { agentName: string }
    bgLog.info(`Trigger received for "${agentName}" — running in sandbox`)
    triggerAgent(agentName).catch((e: unknown) => {
      bgLog.error(`Failed to trigger agent "${agentName}":`, e instanceof Error ? e.message : String(e))
    })
    sendResponse({ success: true })
    return undefined
  }

  // ── Heartbeat: config updated from DO — apply in-process and persist ──
  if (message.type === "heartbeat_config_updated") {
    const { agentName, config } = message as { agentName: string; config: Record<string, unknown> }
    bgLog.info(`Config updated for "${agentName}" — applying in-process`)
    const doUpdate = async () => {
      await updateAgentConfig(agentName, config)
      await applyConfigUpdate(agentName, config)
    }
    doUpdate().catch((e: unknown) => {
      bgLog.error(`Failed to apply config update for "${agentName}":`, e instanceof Error ? e.message : String(e))
    })
    sendResponse({ success: true })
    return undefined
  }

  // ── AI proxy: sandbox agent calls ai.chat/image/video via offscreen → background ──
  if (message.type === "agent_ai_call") {
    const { agentName, method, args } = message as {
      agentName: string
      method:    string
      args:      unknown[]
    }

    const handleAiCall = async () => {
      const { accessToken } = await getTokens()
      if (!accessToken) throw new Error("Not logged in")

      const req = (args[0] ?? {}) as Record<string, unknown>
      const aiUrl = `${APP_BASE}/ai/${method}`

      const res = await fetch(aiUrl, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  accessToken,
        },
        body: JSON.stringify({ ...req, agent_name: agentName }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown error")
        throw new Error(`AI ${method} failed (${res.status}): ${text}`)
      }

      const data = await res.json() as { success: boolean; result?: unknown; message?: string }
      if (!data.success) throw new Error(data.message ?? `AI ${method} rejected`)
      return data.result
    }

    handleAiCall()
      .then(result => sendResponse({ success: true, result }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  return undefined
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const KEEPALIVE_ALARM = "lts_keepalive"

// Bootstrap on install/update — also set up the keepalive alarm
chrome.runtime.onInstalled.addListener(() => {
  bgLog.info("Extension installed/updated — bootstrapping host...")
  // Keepalive alarm: fires every 1 minute (Chrome MV3 minimum) to wake the SW
  // and reconnect WebSocket heartbeats before the DO marks agents OFFLINE (3min timeout)
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })
  void bootstrap()
})

// Keepalive alarm handler — reconnect any dropped heartbeat WS connections
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  void reconnectHeartbeats()
})

// Re-bootstrap every time the service worker wakes up
// (MV3 SWs are terminated when idle and restarted on events)
void bootstrap()
