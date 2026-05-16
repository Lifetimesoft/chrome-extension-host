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
import { startAgent, stopAgent, isAgentRunning, triggerAgent, applyConfigUpdate, reconnectHeartbeats, restoreAgent, forceStopIfRunning, stopAllAgents, getRunId, registerPendingJob } from "../services/runtime.service"
import { handleOffscreenMessage, ensureOffscreenAlive } from "../services/sandbox.service"
import { handleAlarm } from "../services/scheduler.service"
import { getTokens } from "../storage/storage"
import { API_URLS, MESSAGE_TYPES, ALARMS, AGENT_STATUS } from "../constants"
import type { BackgroundMessage } from "../types"

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
    const toRestore = agents.filter(a => a.status === AGENT_STATUS.RUNNING && !isAgentRunning(a.name))

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

  const msg = message as BackgroundMessage

  // ── Auth: login ──
  if (msg.type === MESSAGE_TYPES.AUTH_LOGIN) {
    login()
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Auth: cancel login ──
  if (msg.type === MESSAGE_TYPES.AUTH_LOGIN_CANCEL) {
    cancelLogin()
    sendResponse({ success: true })
    return undefined
  }

  // ── Auth: logout ──
  if (msg.type === MESSAGE_TYPES.AUTH_LOGOUT) {
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
  if (msg.type === MESSAGE_TYPES.AGENT_START) {
    const { name } = msg as BackgroundMessage & { name: string }
    startAgent(name)
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Agent: stop ──
  if (msg.type === MESSAGE_TYPES.AGENT_STOP) {
    const { name } = msg as BackgroundMessage & { name: string }
    stopAgent(name)
      .then(() => sendResponse({ success: true }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── Agent: install ──
  if (msg.type === MESSAGE_TYPES.AGENT_INSTALL) {
    const { name, version, config } = msg as BackgroundMessage & {
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
  if (msg.type === MESSAGE_TYPES.AGENT_UNINSTALL) {
    const { name } = msg as BackgroundMessage & { name: string }
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
  if (msg.type === MESSAGE_TYPES.RUNTIME_DISCONNECT) {
    const { name } = msg as { name?: string }
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
  if (msg.type === MESSAGE_TYPES.RUNTIME_RECONNECT) {
    const { name } = msg as { name?: string }
    const doReconnect = async () => {
      if (name) {
        await startAgent(name)
      } else {
        // Restart all installed agents that were running
        const agents = await listInstalledAgents()
        for (const agent of agents.filter(a => a.status === AGENT_STATUS.RUNNING)) {
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
  if (msg.type === MESSAGE_TYPES.GET_STATUS) {
    const getStatus = async () => {
      const loggedIn = await isLoggedIn()
      const agents = await listInstalledAgents()
      // Sync in-memory running state with stored state
      const agentsWithLiveStatus = agents.map(a => ({
        ...a,
        status: isAgentRunning(a.name) ? AGENT_STATUS.RUNNING : a.status,
      }))
      return { loggedIn, agents: agentsWithLiveStatus }
    }
    getStatus()
      .then(status => sendResponse(status))
      .catch(() => sendResponse({ loggedIn: false, agents: [] }))
    return true
  }

  // ── Navigation: open dashboard ──
  if (msg.type === MESSAGE_TYPES.OPEN_DASHBOARD) {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  // ── Navigation: open logs ──
  if (msg.type === MESSAGE_TYPES.OPEN_LOGS) {
    const { agent } = msg as { agent?: string }
    const url = chrome.runtime.getURL("logs/index.html") + (agent ? `?agent=${encodeURIComponent(agent)}` : "")
    chrome.tabs.create({ url })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  // ── Offscreen: relay messages from offscreen document (sandbox logs/done/error) ──
  if (
    msg.type === MESSAGE_TYPES.OFFSCREEN_LOG   ||
    msg.type === MESSAGE_TYPES.OFFSCREEN_DONE  ||
    msg.type === MESSAGE_TYPES.OFFSCREEN_ERROR
  ) {
    handleOffscreenMessage(msg as Record<string, unknown>)
    sendResponse({ success: true })
    return undefined
  }

  // ── Offscreen: keepalive ping — resets SW idle timer so WS stays connected ──
  if (msg.type === MESSAGE_TYPES.OFFSCREEN_KEEPALIVE) {
    // No-op — receiving this message is enough to reset the SW idle timer
    sendResponse({ success: true })
    return undefined
  }

  // ── Heartbeat: trigger from DO (scheduler type: none) — run agent in sandbox in-process ──
  if (msg.type === MESSAGE_TYPES.HEARTBEAT_TRIGGER) {
    const { agentName } = msg as BackgroundMessage & { agentName: string }
    bgLog.info(`Trigger received for "${agentName}" — running in sandbox`)
    triggerAgent(agentName).catch((e: unknown) => {
      bgLog.error(`Failed to trigger agent "${agentName}":`, e instanceof Error ? e.message : String(e))
    })
    sendResponse({ success: true })
    return undefined
  }

  // ── Heartbeat: config updated from DO — apply in-process and persist ──
  if (msg.type === MESSAGE_TYPES.HEARTBEAT_CONFIG_UPDATED) {
    const { agentName, config } = msg as BackgroundMessage & { agentName: string; config: Record<string, unknown> }
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

  // ── Chrome API proxy: sandbox agent calls chrome.tabs/scripting via offscreen → background ──
  if (msg.type === "agent_chrome_call") {
    const { method, args } = msg as BackgroundMessage & { method: string; args: unknown[] }

    const handleChromeCall = async (): Promise<unknown> => {
      if (method === "tabs.create") {
        const props = args[0] as chrome.tabs.CreateProperties
        return new Promise((resolve, reject) => {
          chrome.tabs.create(props, (tab) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
            resolve(tab)
          })
        })
      }

      if (method === "tabs.remove") {
        const tabId = args[0] as number
        return new Promise<void>((resolve) => {
          chrome.tabs.remove(tabId, () => resolve())
        })
      }

      if (method === "tabs.get") {
        const tabId = args[0] as number
        return new Promise((resolve, reject) => {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
            resolve(tab)
          })
        })
      }

      if (method === "scripting.executeScript") {
        const raw = args[0] as Record<string, unknown>
        // func was serialized as string in sandbox (functions can't cross postMessage).
        // Use chrome.scripting with world:MAIN and pass the function body as a string arg,
        // then eval it inside the target tab — tabs have no CSP restriction on scripting injection.
        if (typeof raw["func"] === "string") {
          const funcStr = raw["func"] as string
          const injectionArgs = (raw["args"] as unknown[]) ?? []
          const target = raw["target"] as chrome.scripting.InjectionTarget
          return chrome.scripting.executeScript({
            target,
            world: "MAIN",
            func: (serializedFn: string, fnArgs: unknown[]) => {
              // eslint-disable-next-line no-new-func
              const fn = new Function(`return (${serializedFn})`)() as (...a: unknown[]) => unknown
              return fn(...fnArgs)
            },
            args: [funcStr, injectionArgs],
          })
        }
        return chrome.scripting.executeScript(raw as chrome.scripting.ScriptInjection<unknown[], unknown>)
      }

      throw new Error(`Unsupported chrome method: ${method}`)
    }

    handleChromeCall()
      .then(result => sendResponse({ success: true, result }))
      .catch((e: unknown) => sendResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    return true
  }

  // ── AI proxy: sandbox agent calls ai.chat/image/video via offscreen → background ──
  if (msg.type === MESSAGE_TYPES.AGENT_AI_CALL) {
    const { agentName, method, args } = msg as BackgroundMessage & {
      agentName: string
      method:    string
      args:      unknown[]
    }

    const handleAiCall = async () => {
      const { accessToken } = await getTokens()
      if (!accessToken) throw new Error("Not logged in")

      const req = (args[0] ?? {}) as Record<string, unknown>

      // Resolve run_id for the agent so DO can notify back via WS (image_ready/video_ready)
      const runId = getRunId(agentName)

      const aiUrl = `${API_URLS.AGENT_BASE}/ai/${method}`
      const res = await fetch(aiUrl, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  accessToken,
        },
        body: JSON.stringify({ ...req, agent_name: agentName, ...(runId ? { run_id: runId } : {}) }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown error")
        throw new Error(`AI ${method} failed (${res.status}): ${text}`)
      }

      const data = await res.json() as { success: boolean; result?: unknown; job_id?: string; message?: string }
      if (!data.success) throw new Error(data.message ?? `AI ${method} rejected`)

      // image/video: wait for WS callback (image_ready / video_ready) instead of returning immediately
      if ((method === "image" || method === "video") && data.job_id) {
        bgLog.info(`AI ${method} job ${data.job_id} submitted — waiting for ${method}_ready...`)
        return registerPendingJob(method as "image" | "video", data.job_id)
      }

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

// Bootstrap on install/update — also set up the keepalive alarm
chrome.runtime.onInstalled.addListener(() => {
  bgLog.info("Extension installed/updated — bootstrapping host...")
  // Keepalive alarm: fires every 1 minute (Chrome MV3 minimum) to wake the SW
  // and reconnect WebSocket heartbeats before the DO marks agents OFFLINE (3min timeout)
  chrome.alarms.create(ALARMS.KEEPALIVE, { periodInMinutes: 1 })
  void bootstrap()
})

// Graceful shutdown on service worker suspend
chrome.runtime.onSuspend.addListener(() => {
  bgLog.info("Service worker suspending — stopping all agents...")
  // Best-effort cleanup before SW is terminated
  stopAllAgents().catch(() => { /* best-effort */ })
})

// Keepalive alarm handler — reconnect any dropped heartbeat WS connections
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.KEEPALIVE) {
    void reconnectHeartbeats()
  } else {
    // Handle scheduler alarms
    handleAlarm(alarm)
  }
})

// Re-bootstrap every time the service worker wakes up
// (MV3 SWs are terminated when idle and restarted on events)
void bootstrap()
