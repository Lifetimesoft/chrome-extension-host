/// <reference types="chrome" />

/**
 * Logs Page Script
 *
 * - Reads ?agent=name from URL to show per-agent logs
 * - Falls back to showing all agents if no param
 * - Real-time updates via chrome.storage.onChanged
 * - Filter by level and text search
 */

import type { LogEntry } from "../utils/logger"
import { agentLogKey } from "../storage/storage"

// ─── URL param ────────────────────────────────────────────────────────────────

const urlParams  = new URLSearchParams(window.location.search)
const agentParam = urlParams.get("agent") ?? null

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const logContainer = document.getElementById("log-container")  as HTMLDivElement
const searchInput  = document.getElementById("search")         as HTMLInputElement
const levelSelect  = document.getElementById("level-filter")   as HTMLSelectElement
const agentSelect  = document.getElementById("agent-filter")   as HTMLSelectElement
const clearBtn     = document.getElementById("clear-btn")      as HTMLButtonElement
const countEl      = document.getElementById("log-count")      as HTMLSpanElement
const emptyEl      = document.getElementById("empty-state")    as HTMLDivElement
const titleEl      = document.getElementById("page-title")     as HTMLSpanElement
const statusAgent  = document.getElementById("status-agent")   as HTMLSpanElement

// ─── State ────────────────────────────────────────────────────────────────────

// Map of agentName → LogEntry[]
let allEntriesByAgent: Record<string, LogEntry[]> = {}
let autoScroll = true

// ─── Render helpers ───────────────────────────────────────────────────────────

const LEVEL_BADGE: Record<string, string> = {
  info:  "badge-info",
  warn:  "badge-warn",
  error: "badge-error",
  debug: "badge-debug",
}

const LEVEL_MSG: Record<string, string> = {
  info:  "msg-info",
  warn:  "msg-warn",
  error: "msg-error",
  debug: "msg-debug",
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderEntry(entry: LogEntry, agentName: string): HTMLDivElement {
  const row = document.createElement("div")
  row.className = "log-row"
  row.dataset.level = entry.level
  row.dataset.agent = agentName
  row.dataset.text  = `${entry.tag} ${entry.msg}`.toLowerCase()

  row.innerHTML = `
    <span class="log-ts">${fmtTime(entry.ts)}</span>
    <span class="log-badge ${LEVEL_BADGE[entry.level] ?? LEVEL_BADGE.info}">${entry.level}</span>
    <span class="log-tag">${escHtml(entry.tag)}</span>
    <span class="log-msg ${LEVEL_MSG[entry.level] ?? LEVEL_MSG.info}">${escHtml(entry.msg)}</span>
  `
  return row
}

function applyFilters(): void {
  const q      = searchInput.value.trim().toLowerCase()
  const level  = levelSelect.value
  const agent  = agentSelect.value

  let visible = 0
  for (const row of Array.from(logContainer.querySelectorAll<HTMLDivElement>(".log-row"))) {
    const matchLevel  = !level || row.dataset.level === level
    const matchAgent  = !agent || row.dataset.agent === agent
    const matchSearch = !q    || (row.dataset.text ?? "").includes(q)
    const show = matchLevel && matchAgent && matchSearch
    row.style.display = show ? "" : "none"
    if (show) visible++
  }

  countEl.textContent = String(visible)
  emptyEl.style.display = visible === 0 ? "flex" : "none"
}

function renderAll(): void {
  logContainer.innerHTML = ""

  // Flatten all entries sorted by timestamp
  const allEntries: Array<{ entry: LogEntry; agentName: string }> = []
  for (const [agentName, entries] of Object.entries(allEntriesByAgent)) {
    for (const entry of entries) {
      allEntries.push({ entry, agentName })
    }
  }
  allEntries.sort((a, b) => a.entry.ts - b.entry.ts)

  for (const { entry, agentName } of allEntries) {
    logContainer.appendChild(renderEntry(entry, agentName))
  }

  countEl.textContent = String(allEntries.length)
  emptyEl.style.display = allEntries.length === 0 ? "flex" : "none"
  applyFilters()
  if (autoScroll) scrollToBottom()
}

function scrollToBottom(): void {
  logContainer.scrollTop = logContainer.scrollHeight
}

// ─── Agent filter dropdown ────────────────────────────────────────────────────

function updateAgentFilter(): void {
  const agents = Object.keys(allEntriesByAgent)

  // Clear existing options (keep "All agents")
  while (agentSelect.options.length > 1) {
    agentSelect.remove(1)
  }

  for (const name of agents) {
    const opt = document.createElement("option")
    opt.value = name
    opt.textContent = name
    agentSelect.appendChild(opt)
  }

  // If a specific agent was requested via URL, pre-select it
  if (agentParam && agents.includes(agentParam)) {
    agentSelect.value = agentParam
  }
}

// ─── Load initial logs ────────────────────────────────────────────────────────

async function loadLogs(): Promise<void> {
  const all = await chrome.storage.local.get(null)

  allEntriesByAgent = {}
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("lts_logs_")) {
      const name = key.slice("lts_logs_".length)
      allEntriesByAgent[name] = (value as LogEntry[] | undefined) ?? []
    }
  }

  updateAgentFilter()
  renderAll()

  // Update page title
  if (agentParam) {
    titleEl.textContent = `Logs — ${agentParam}`
    statusAgent.textContent = agentParam
  } else {
    titleEl.textContent = "All Agent Logs"
    statusAgent.textContent = "all agents"
  }
}

// ─── Real-time updates ────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return

  let changed = false
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith("lts_logs_")) {
      const name = key.slice("lts_logs_".length)
      allEntriesByAgent[name] = (change.newValue as LogEntry[] | undefined) ?? []
      changed = true
    }
  }

  if (changed) {
    updateAgentFilter()
    renderAll()
  }
})

// ─── Auto-scroll detection ────────────────────────────────────────────────────

logContainer.addEventListener("scroll", () => {
  const threshold = 40
  autoScroll = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < threshold
})

// ─── Controls ─────────────────────────────────────────────────────────────────

searchInput.addEventListener("input", applyFilters)
levelSelect.addEventListener("change", applyFilters)
agentSelect.addEventListener("change", applyFilters)

clearBtn.addEventListener("click", async () => {
  const agentToClear = agentSelect.value || agentParam

  if (agentToClear) {
    // Clear only the selected agent's logs
    await chrome.storage.local.set({ [agentLogKey(agentToClear)]: [] })
    allEntriesByAgent[agentToClear] = []
  } else {
    // Clear all agent logs
    const keysToRemove = Object.keys(allEntriesByAgent).map(agentLogKey)
    if (keysToRemove.length > 0) {
      const clearData: Record<string, LogEntry[]> = {}
      for (const key of keysToRemove) clearData[key] = []
      await chrome.storage.local.set(clearData)
    }
    allEntriesByAgent = {}
  }

  renderAll()
})

// ─── Init ─────────────────────────────────────────────────────────────────────

void loadLogs()
