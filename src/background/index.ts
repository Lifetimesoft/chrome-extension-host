/// <reference types="chrome" />

/**
 * Background Service Worker (MV3) — Host Entry Point
 *
 * Acts like Docker Desktop or Steam: manages multiple agent runtimes.
 * On install/wake: bootstraps all previously-running agents.
 * Handles messages from popup and dashboard.
 */

import { bgLog } from "../utils/logger"
import { login, logout, cancelLogin, isLoggedIn } from "../services/auth.service"
import { listInstalledAgents, installAgent, uninstallAgent } from "../services/agent.service"
import { startAgent, stopAgent, isAgentRunning } from "../services/runtime.service"

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  bgLog.info("Host bootstrapping...")

  const loggedIn = await isLoggedIn()
  if (!loggedIn) {
    bgLog.info("Not logged in — waiting for user to authenticate via popup")
    return
  }

  const agents = await listInstalledAgents()
  const runningAgents = agents.filter(a => a.status === "running")

  if (runningAgents.length === 0) {
    bgLog.info("No previously running agents to restore")
    return
  }

  bgLog.info(`Restoring ${runningAgents.length} previously running agent(s)...`)

  for (const agent of runningAgents) {
    try {
      await startAgent(agent.name)
      bgLog.info(`Restored agent "${agent.name}"`)
    } catch (e) {
      bgLog.error(`Failed to restore agent "${agent.name}":`, e instanceof Error ? e.message : String(e))
    }
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return undefined

  // ── Auth: login ──
  if (message.type === "auth_login") {
    login()
      .then(() => {
        // Notify popup that login is done
        chrome.runtime.sendMessage({ type: "login_complete" }).catch(() => { /* popup may be closed */ })
        sendResponse({ success: true })
      })
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
      // Stop runtime first if running
      if (isAgentRunning(name)) {
        await stopAgent(name)
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
    chrome.tabs.create({ url: chrome.runtime.getURL("dist/dashboard/index.html") })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  // ── Navigation: open logs ──
  if (message.type === "open_logs") {
    const { agent } = message as { agent?: string }
    const url = chrome.runtime.getURL("dist/logs/index.html") + (agent ? `?agent=${encodeURIComponent(agent)}` : "")
    chrome.tabs.create({ url })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  return undefined
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

// Bootstrap on install/update
chrome.runtime.onInstalled.addListener(() => {
  bgLog.info("Extension installed/updated — bootstrapping host...")
  void bootstrap()
})

// Re-bootstrap every time the service worker wakes up
// (MV3 SWs are terminated when idle and restarted on events)
void bootstrap()
