/// <reference types="chrome" />

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
let _devUrls: Record<string, string> = {}

async function loadDevUrls(agents: InstalledAgent[]): Promise<void> {
  const keys = agents.map(a => `lts_dev_bundle_${a.name}`)
  if (keys.length === 0) { _devUrls = {}; return }
  const stored = await chrome.storage.local.get(keys)
  _devUrls = {}
  for (const a of agents) {
    _devUrls[a.name] = (stored[`lts_dev_bundle_${a.name}`] as string) ?? ""
  }
}

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
  container.innerHTML = agents.map(agent => {
    const devUrl = _devUrls[agent.name] ?? ""
    const devBadge = devUrl ? `<span class="dev-active-badge">⚡ dev</span>` : ""
    const alias = agent.alias ? ` <span class="agent-alias">(${escHtml(agent.alias)})</span>` : ""
    return `
    <div class="agent-card" data-name="${escHtml(agent.name)}" style="cursor:pointer;">
      <div class="agent-card-header">
        <div class="agent-info">
          <div class="agent-name">${escHtml(agent.name)}${alias}${devBadge}</div>
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
        </div>
      </div>
      ${agent.run_id ? `<div class="agent-run-id">run_id: <code>${escHtml(agent.run_id)}</code></div>` : ""}
    </div>
  `}).join("")

  // Button clicks — stop propagation so card click doesn't fire
  container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      handleAgentAction(btn.dataset.action!, btn.dataset.name!, btn)
    })
  })

  // Card click → navigate to agent detail page
  container.querySelectorAll<HTMLDivElement>(".agent-card").forEach(card => {
    card.addEventListener("click", () => {
      const name = card.dataset.name!
      location.href = `../agent-detail/index.html?name=${encodeURIComponent(name)}`
    })
  })
}

// ─── Agent actions ────────────────────────────────────────────────────────────

async function handleAgentAction(action: string, name: string, btn?: HTMLButtonElement): Promise<void> {
  setNotification("", false)
  if (btn) btn.disabled = true

  try {
    if (action === "start") {
      setNotification(`Starting "${name}"...`, false)
      const res = await sendMsg<GenericResponse>({ type: "agent_start", name }).catch(e => ({
        success: false, error: e instanceof Error ? e.message : String(e),
      }))
      if (!res.success) setNotification(`Failed to start "${name}": ${res.error ?? "unknown error"}`, true)
    }

    if (action === "stop") {
      setNotification(`Stopping "${name}"...`, false)
      await sendMsg({ type: "agent_stop", name }).catch(() => {})
    }

    if (action === "logs") {
      await sendMsg({ type: "open_logs", agent: name }).catch(() => {})
      if (btn) btn.disabled = false
      return
    }

    await refreshStatus()
  } finally {
    if (btn && document.body.contains(btn)) btn.disabled = false
  }
}

// ─── Status refresh ───────────────────────────────────────────────────────────

async function refreshStatus(): Promise<void> {
  const status = await sendMsg<StatusResponse>({ type: "get_status" }).catch(
    () => ({ loggedIn: false, agents: [] } as StatusResponse)
  )
  _loggedIn = status.loggedIn
  _agents   = status.agents
  await loadDevUrls(_agents)
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
  const manifest = chrome.runtime.getManifest()
  el<HTMLSpanElement>("ext-version").textContent = `(v${manifest.version})`

  await refreshStatus()

  const installBtn  = el<HTMLButtonElement>("install-btn")
  const installName = el<HTMLInputElement>("install-name")
  const installVer  = el<HTMLInputElement>("install-version")

  async function doInstall(): Promise<void> {
    const name    = installName.value.trim()
    const version = installVer.value.trim() || "latest"
    if (!name) { setNotification("Please enter an agent name", true); return }

    installBtn.disabled = true
    setNotification(`Installing "${name}@${version}"...`, false)

    const res = await sendMsg<{ success: boolean; error?: string }>({
      type: "agent_install", name, version,
    }).catch(e => ({ success: false, error: e instanceof Error ? e.message : String(e) }))

    installBtn.disabled = false

    if (res.success) {
      installName.value = ""
      installVer.value  = ""
      setNotification(`"${name}@${version}" installed — click ▶ Start to run it`, false)
      await refreshStatus()
    } else {
      setNotification(`Install failed: ${res.error ?? "unknown error"}`, true)
    }
  }

  installBtn.addEventListener("click", doInstall)
  installName.addEventListener("keydown", (e) => { if (e.key === "Enter") void doInstall() })
  installVer.addEventListener("keydown",  (e) => { if (e.key === "Enter") void doInstall() })

  el<HTMLButtonElement>("logout-btn").addEventListener("click", async () => {
    if (!confirm("Sign out? All running agents will be stopped.")) return
    await sendMsg({ type: "auth_logout" }).catch(() => {})
    await refreshStatus()
    setNotification("Signed out", false)
  })

  el<HTMLButtonElement>("refresh-btn").addEventListener("click", async () => {
    await refreshStatus()
  })

  setInterval(() => { void refreshStatus() }, 5_000)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes["lts_installed_agents"] || Object.keys(changes).some(k => k.startsWith("lts_dev_bundle_")))) {
      void refreshStatus()
    }
  })
}

void run()
