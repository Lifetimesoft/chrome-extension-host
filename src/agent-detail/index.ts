/// <reference types="chrome" />

import type { InstalledAgent } from "../storage/storage"

interface StatusResponse {
  loggedIn: boolean
  agents: InstalledAgent[]
}

interface AgentAliasResponse {
  success: boolean
  error?: string
  agent?: InstalledAgent
}

const DEV_URL_PREFIX = "lts_dev_bundle_"

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function sendMsg<T>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage(message)
  if (response === undefined) {
    throw new Error(chrome.runtime.lastError?.message ?? "No response from background service worker")
  }
  return response as T
}

function setNotification(text: string, isError: boolean): void {
  const n = el<HTMLDivElement>("notification")
  n.textContent = text
  n.className = text ? (isError ? "notification error" : "notification info") : "notification"
}

function getAgentNameFromUrl(): string {
  return new URLSearchParams(location.search).get("name") ?? ""
}

async function run(): Promise<void> {
  const agentName = getAgentNameFromUrl()
  if (!agentName) {
    setNotification("No agent specified", true)
    return
  }

  // Load agent data
  const status = await sendMsg<StatusResponse>({ type: "get_status" }).catch(
    () => ({ loggedIn: false, agents: [] } as StatusResponse)
  )
  const loadedAgent = status.agents.find(a => a.name === agentName)
  if (!loadedAgent) {
    setNotification(`Agent "${agentName}" not found`, true)
    return
  }
  let agent: InstalledAgent = loadedAgent

  // Load dev URL
  const stored = await chrome.storage.local.get(DEV_URL_PREFIX + agentName)
  const devUrl = (stored[DEV_URL_PREFIX + agentName] as string) ?? ""

  // ── Render header ──
  el("agent-name").textContent = agent.name
  el("agent-meta").textContent = `v${agent.version} · installed ${new Date(agent.installed_at).toLocaleDateString()}`

  function renderInfoRows(a: InstalledAgent): void {
    const rows: Array<{ label: string; value: string }> = [
      { label: "Version",      value: a.version },
      ...(a.alias ? [{ label: "Name", value: a.alias }] : []),
      { label: "Status",       value: a.status },
      { label: "Installed",    value: new Date(a.installed_at).toLocaleString() },
      ...(a.run_id    ? [{ label: "Run ID",    value: a.run_id }]    : []),
      ...(a.instance_id !== undefined ? [{ label: "Instance ID", value: String(a.instance_id) }] : []),
    ]
    el("info-rows").innerHTML = rows.map(r =>
      `<div class="info-row"><span class="info-label">${escHtml(r.label)}</span><span class="info-value">${escHtml(r.value)}</span></div>`
    ).join("")
  }

  const aliasInput = el<HTMLInputElement>("alias-input")
  const aliasDesc = el<HTMLParagraphElement>("alias-desc")
  const aliasSaveBtn = el<HTMLButtonElement>("alias-save-btn")
  aliasInput.value = agent.alias ?? ""
  renderInfoRows(agent)

  // ── Status badge + toggle button ──
  function updateStatusUI(a: InstalledAgent): void {
    const badge = el("status-badge")
    const btn   = el<HTMLButtonElement>("toggle-btn")
    if (a.status === "running") {
      badge.className = "badge badge-running"
      badge.textContent = "● Running"
      btn.className = "btn-action btn-stop"
      btn.textContent = "⏸ Stop"
      aliasDesc.textContent = "Saved in Chrome. The running agent keeps its current SaaS name until the next start or restart."
    } else if (a.status === "error") {
      badge.className = "badge badge-error"
      badge.textContent = "✕ Error"
      btn.className = "btn-action btn-start"
      btn.textContent = "▶ Start"
      aliasDesc.textContent = "Saved in Chrome. It is sent to SaaS on the next start or restart."
    } else {
      badge.className = "badge badge-stopped"
      badge.textContent = "○ Stopped"
      btn.className = "btn-action btn-start"
      btn.textContent = "▶ Start"
      aliasDesc.textContent = "Saved in Chrome. It is sent to SaaS on the next start or restart."
    }
  }

  updateStatusUI(agent)

  aliasSaveBtn.addEventListener("click", async () => {
    const alias = aliasInput.value.trim()
    aliasSaveBtn.disabled = true
    try {
      const res: AgentAliasResponse = await sendMsg<AgentAliasResponse>({
        type: "agent_update_alias",
        name: agentName,
        alias: alias || null,
      }).catch(e => ({ success: false, error: e instanceof Error ? e.message : String(e) }))

      if (res.success && res.agent) {
        agent = res.agent
        aliasInput.value = agent.alias ?? ""
        renderInfoRows(agent)
        updateStatusUI(agent)
        setNotification(alias ? `Name saved for "${agentName}"` : `Name cleared for "${agentName}"`, false)
        setTimeout(() => setNotification("", false), 3000)
      } else {
        setNotification(`Save failed: ${res.error ?? "unknown"}`, true)
      }
    } finally {
      aliasSaveBtn.disabled = false
    }
  })

  el<HTMLButtonElement>("toggle-btn").addEventListener("click", async () => {
    const btn = el<HTMLButtonElement>("toggle-btn")
    btn.disabled = true
    const current = await sendMsg<StatusResponse>({ type: "get_status" })
    const current_agent = current.agents.find(a => a.name === agentName)
    const isRunning = current_agent?.status === "running"

    if (isRunning) {
      setNotification(`Stopping "${agentName}"...`, false)
      await sendMsg({ type: "agent_stop", name: agentName }).catch(() => {})
    } else {
      const alias = aliasInput.value.trim()
      setNotification(`Starting "${agentName}"...`, false)
      const res = await sendMsg<{ success: boolean; error?: string }>({
        type: "agent_start",
        name: agentName,
        alias: alias || null,
      })
        .catch(e => ({ success: false, error: e instanceof Error ? e.message : String(e) }))
      if (!res.success) {
        setNotification(`Failed to start: ${res.error ?? "unknown"}`, true)
        btn.disabled = false
        return
      }
    }

    // Refresh status
    const updated = await sendMsg<StatusResponse>({ type: "get_status" })
    const updatedAgent = updated.agents.find(a => a.name === agentName)
    if (updatedAgent) {
      agent = updatedAgent
      renderInfoRows(agent)
      updateStatusUI(agent)
    }
    setNotification("", false)
    btn.disabled = false
  })

  // ── Dev bundle URL ──
  const devInput = el<HTMLInputElement>("dev-url-input")
  const devActive = el<HTMLDivElement>("dev-active")

  devInput.value = devUrl

  function updateDevActive(url: string): void {
    if (url) {
      devActive.textContent = `⚡ Active: ${url}`
      devActive.classList.add("show")
    } else {
      devActive.textContent = ""
      devActive.classList.remove("show")
    }
  }

  updateDevActive(devUrl)

  el("dev-save-btn").addEventListener("click", async () => {
    const url = devInput.value.trim()
    const key = DEV_URL_PREFIX + agentName
    if (url) {
      await chrome.storage.local.set({ [key]: url })
    } else {
      await chrome.storage.local.remove(key)
    }
    updateDevActive(url)
    setNotification(url ? `Dev URL saved for "${agentName}"` : `Dev URL cleared`, false)
    setTimeout(() => setNotification("", false), 3000)
  })

  el("dev-clear-btn").addEventListener("click", async () => {
    devInput.value = ""
    await chrome.storage.local.remove(DEV_URL_PREFIX + agentName)
    updateDevActive("")
    setNotification(`Dev URL cleared for "${agentName}"`, false)
    setTimeout(() => setNotification("", false), 3000)
  })

  // ── Uninstall ──
  el("uninstall-btn").addEventListener("click", async () => {
    if (!confirm(`Uninstall agent "${agentName}"? This will stop it if running.`)) return
    const res = await sendMsg<{ success: boolean; error?: string }>({ type: "agent_uninstall", name: agentName })
      .catch(e => ({ success: false, error: e instanceof Error ? e.message : String(e) }))
    if (res.success) {
      await chrome.storage.local.remove(DEV_URL_PREFIX + agentName)
      location.href = "../dashboard/index.html"
    } else {
      setNotification(`Uninstall failed: ${res.error ?? "unknown"}`, true)
    }
  })
}

void run()
