/// <reference types="chrome" />

/**
 * Dashboard Script — full-tab agent management UI
 *
 * Sections:
 * - Installed Agents: list with status badges, start/stop buttons
 * - Settings: disconnect/reconnect/logout
 */

import type { InstalledAgent } from "../storage/storage"

interface StatusResponse {
  loggedIn: boolean
  agents:   InstalledAgent[]
}

interface GenericResponse {
  success: boolean
  error?:  string
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function sendMsg<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>
}

// ─── State ────────────────────────────────────────────────────────────────────

let _agents: InstalledAgent[] = []
let _loggedIn = false

// ─── Render agents ────────────────────────────────────────────────────────────

function statusBadgeHtml(status: InstalledAgent["status"]): string {
  const classes: Record<InstalledAgent["status"], string> = {
    running: "badge-running",
    stopped: "badge-stopped",
    error:   "badge-error",
  }
  const labels: Record<InstalledAgent["status"], string> = {
    running: "● Running",
    stopped: "○ Stopped",
    error:   "✕ Error",
  }
  return `<span class="badge ${classes[status]}">${labels[status]}</span>`
}

function renderAgents(agents: InstalledAgent[]): void {
  const container = el<HTMLDivElement>("agents-list")
  const empty     = el<HTMLDivElement>("agents-empty")

  if (agents.length === 0) {
    container.innerHTML = ""
    empty.style.display = "flex"
    return
  }

  empty.style.display = "none"
  container.innerHTML = agents.map(agent => `
    <div class="agent-card" data-name="${escHtml(agent.name)}">
      <div class="agent-card-header">
        <div class="agent-info">
          <div class="agent-name">${escHtml(agent.name)}</div>
          <div class="agent-meta">v${escHtml(agent.version)} · installed ${new Date(agent.installed_at).toLocaleDateString()}</div>
        </div>
        <div class="agent-actions">
          ${statusBadgeHtml(agent.status)}
          ${agent.status === "running"
            ? `<button class="btn-action btn-stop" data-action="stop" data-name="${escHtml(agent.name)}">⏸ Stop</button>`
            : `<button class="btn-action btn-start" data-action="start" data-name="${escHtml(agent.name)}">▶ Start</button>`
          }
          <button class="btn-action btn-logs" data-action="logs" data-name="${escHtml(agent.name)}" title="View logs">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </button>
          <button class="btn-action btn-uninstall" data-action="uninstall" data-name="${escHtml(agent.name)}" title="Uninstall">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      ${agent.run_id ? `<div class="agent-run-id">run_id: <code>${escHtml(agent.run_id)}</code></div>` : ""}
    </div>
  `).join("")

  // Attach event listeners
  container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => handleAgentAction(btn.dataset.action!, btn.dataset.name!))
  })
}

// ─── Agent actions ────────────────────────────────────────────────────────────

async function handleAgentAction(action: string, name: string): Promise<void> {
  setNotification("", false)

  if (action === "start") {
    setNotification(`Starting "${name}"...`, false)
    const res = await sendMsg<GenericResponse>({ type: "agent_start", name }).catch(e => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }))
    if (!res.success) {
      setNotification(`Failed to start "${name}": ${res.error ?? "unknown error"}`, true)
    }
  }

  if (action === "stop") {
    setNotification(`Stopping "${name}"...`, false)
    await sendMsg({ type: "agent_stop", name }).catch(() => {})
  }

  if (action === "logs") {
    await sendMsg({ type: "open_logs", agent: name }).catch(() => {})
    return
  }

  if (action === "uninstall") {
    if (!confirm(`Uninstall agent "${name}"? This will stop it if running.`)) return
    const res = await sendMsg<GenericResponse>({ type: "agent_uninstall", name }).catch(e => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }))
    if (!res.success) {
      setNotification(`Failed to uninstall "${name}": ${res.error ?? "unknown error"}`, true)
    }
  }

  // Refresh status after action
  await refreshStatus()
}

// ─── Status refresh ───────────────────────────────────────────────────────────

async function refreshStatus(): Promise<void> {
  const status = await sendMsg<StatusResponse>({ type: "get_status" }).catch(
    () => ({ loggedIn: false, agents: [] } as StatusResponse)
  )

  _loggedIn = status.loggedIn
  _agents   = status.agents

  renderAgents(_agents)
  updateSettingsSection()
}

function updateSettingsSection(): void {
  el<HTMLDivElement>("settings-logged-in").style.display  = _loggedIn ? "block" : "none"
  el<HTMLDivElement>("settings-logged-out").style.display = _loggedIn ? "none"  : "block"
}

// ─── Notification ─────────────────────────────────────────────────────────────

function setNotification(text: string, isError: boolean): void {
  const n = el<HTMLDivElement>("notification")
  n.textContent = text
  n.className   = text ? (isError ? "notification error" : "notification info") : "notification"
  n.style.display = text ? "block" : "none"
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Show extension version in header
  const manifest = chrome.runtime.getManifest()
  el<HTMLSpanElement>("ext-version").textContent = `(v${manifest.version})`

  await refreshStatus()

  // ── Disconnect all ──
  el<HTMLButtonElement>("disconnect-all-btn").addEventListener("click", async () => {
    setNotification("Disconnecting all agents...", false)
    await sendMsg({ type: "runtime_disconnect" }).catch(() => {})
    await refreshStatus()
    setNotification("All agents disconnected", false)
  })

  // ── Reconnect all ──
  el<HTMLButtonElement>("reconnect-all-btn").addEventListener("click", async () => {
    setNotification("Reconnecting agents...", false)
    const res = await sendMsg<GenericResponse>({ type: "runtime_reconnect" }).catch(e => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }))
    await refreshStatus()
    if (res.success) {
      setNotification("Agents reconnected", false)
    } else {
      setNotification(`Reconnect failed: ${res.error ?? "unknown error"}`, true)
    }
  })

  // ── Logout ──
  el<HTMLButtonElement>("logout-btn").addEventListener("click", async () => {
    if (!confirm("Sign out? All running agents will be stopped.")) return
    await sendMsg({ type: "auth_logout" }).catch(() => {})
    await refreshStatus()
    setNotification("Signed out", false)
  })

  // ── Refresh button ──
  el<HTMLButtonElement>("refresh-btn").addEventListener("click", async () => {
    await refreshStatus()
  })

  // ── Auto-refresh every 5s ──
  setInterval(() => { void refreshStatus() }, 5_000)

  // ── Listen for storage changes (real-time agent status updates) ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["lts_installed_agents"]) {
      void refreshStatus()
    }
  })
}

void run()
