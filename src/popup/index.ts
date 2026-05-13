/// <reference types="chrome" />

/**
 * Popup Script
 *
 * Not logged in: "Login with LifetimeSoft" button + polling state
 * Logged in: running agent count + "Open Dashboard" button + Settings (⚙️) menu with "View Logs"
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

function show(id: string): void { el(id).style.display = "block" }
function hide(id: string): void { el(id).style.display = "none"  }

function setStatus(text: string, isError = false): void {
  const s = el<HTMLParagraphElement>("status")
  s.textContent = text
  s.className = isError ? "error" : ""
}

async function sendMsg<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>
}

// ─── Views ────────────────────────────────────────────────────────────────────

function showLoginView(polling = false): void {
  show("login-view")
  hide("main-view")

  el<HTMLButtonElement>("login-btn").style.display  = polling ? "none"  : "block"
  el<HTMLDivElement>("polling-state").style.display = polling ? "block" : "none"
}

function showMainView(status: StatusResponse): void {
  hide("login-view")
  show("main-view")

  const running = status.agents.filter(a => a.status === "running").length
  const total   = status.agents.length

  el<HTMLSpanElement>("agent-count").textContent = String(running)
  el<HTMLSpanElement>("agent-total").textContent = String(total)

  // Status dot: green if any running, yellow if all stopped
  el<HTMLSpanElement>("status-dot").className    = running > 0 ? "dot green" : "dot yellow"
  el<HTMLSpanElement>("status-label").textContent = running > 0
    ? `${running} agent${running !== 1 ? "s" : ""} running`
    : total > 0 ? "All agents stopped" : "No agents installed"
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Show extension version in header
  const manifest = chrome.runtime.getManifest()
  el<HTMLSpanElement>("ext-version").textContent = `(v${manifest.version})`

  const status = await sendMsg<StatusResponse>({ type: "get_status" }).catch(
    () => ({ loggedIn: false, agents: [] } as StatusResponse)
  )

  if (status.loggedIn) {
    showMainView(status)
  } else {
    showLoginView()
  }

  // ── Login button ──
  el<HTMLButtonElement>("login-btn").addEventListener("click", async () => {
    showLoginView(true)
    setStatus("")

    try {
      await sendMsg<GenericResponse>({ type: "auth_login" })
      const newStatus = await sendMsg<StatusResponse>({ type: "get_status" })
      if (newStatus.loggedIn) {
        showMainView(newStatus)
      } else {
        showLoginView()
        setStatus("Login failed — please try again", true)
      }
    } catch (e) {
      showLoginView()
      setStatus(e instanceof Error ? e.message : "Login failed", true)
    }
  })

  // ── Cancel polling ──
  el<HTMLButtonElement>("cancel-btn").addEventListener("click", async () => {
    await sendMsg({ type: "auth_login_cancel" }).catch(() => {})
    showLoginView()
    setStatus("Login cancelled")
  })

  // ── Open Dashboard ──
  el<HTMLButtonElement>("dashboard-btn").addEventListener("click", async () => {
    await sendMsg({ type: "open_dashboard" }).catch(() => {})
    window.close()
  })

  // ── Logout ──
  el<HTMLButtonElement>("logout-btn").addEventListener("click", async () => {
    await sendMsg({ type: "auth_logout" }).catch(() => {})
    showLoginView()
    setStatus("")
  })

  // ── Settings menu toggle ──
  el<HTMLButtonElement>("settings-btn").addEventListener("click", () => {
    const menu = el<HTMLDivElement>("settings-menu")
    menu.style.display = menu.style.display === "block" ? "none" : "block"
  })

  // ── Open Logs ──
  el<HTMLButtonElement>("open-logs-btn").addEventListener("click", async () => {
    el<HTMLDivElement>("settings-menu").style.display = "none"
    await sendMsg({ type: "open_logs" }).catch(() => {})
    window.close()
  })

  // Close settings menu when clicking outside
  document.addEventListener("click", (e) => {
    const btn  = el<HTMLButtonElement>("settings-btn")
    const menu = el<HTMLDivElement>("settings-menu")
    if (!btn.contains(e.target as Node) && !menu.contains(e.target as Node)) {
      menu.style.display = "none"
    }
  })

  // ── Listen for login_complete from background ──
  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message === "object" && message !== null && message.type === "login_complete") {
      sendMsg<StatusResponse>({ type: "get_status" }).then(showMainView).catch(() => {})
    }
  })
}

void run()
