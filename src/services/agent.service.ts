/// <reference types="chrome" />

/**
 * Agent Service — install, uninstall, list agents from registry.
 *
 * Manages the metadata of installed agents in chrome.storage.local.
 * Does not manage runtime state — that's runtime.service.ts.
 */

import {
  getInstalledAgents,
  getInstalledAgent,
  upsertInstalledAgent,
  removeInstalledAgent,
  getTokens,
  type InstalledAgent,
} from "../storage/storage"
import { bgLog } from "../utils/logger"

export type { InstalledAgent }

const API_BASE = "https://app.lifetimesoft.com/cli/ai-account-management"

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listInstalledAgents(): Promise<InstalledAgent[]> {
  return getInstalledAgents()
}

export async function getAgent(name: string): Promise<InstalledAgent | undefined> {
  return getInstalledAgent(name)
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Install an agent by name and version.
 * Validates the agent exists in the registry and is compatible with this host.
 * If version is "latest" or omitted, resolves the actual version from the API.
 * The agent starts in "stopped" state — call runtimeService.startAgent() to run it.
 */
export async function installAgent(
  name: string,
  version: string,
  config: Record<string, unknown> = {}
): Promise<InstalledAgent> {
  // ── Validate against registry ──
  const { accessToken } = await getTokens()
  if (!accessToken) throw new Error("Not logged in — please authenticate first")

  const isLatest = !version || version === "latest"
  const query = isLatest
    ? `?name=${encodeURIComponent(name)}&host=chrome`
    : `?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}&host=chrome`

  const res = await fetch(`${API_BASE}/agents/info${query}`, {
    headers: { Authorization: accessToken },
  })

  if (res.status === 404) {
    const body = await res.json() as { message?: string }
    throw new Error(body.message ?? `Agent "${name}" not found in registry`)
  }

  if (!res.ok) {
    throw new Error(`Registry check failed (${res.status})`)
  }

  const info = await res.json() as {
    success:      boolean
    name:         string
    version:      string
    latest_version: string
    description:  string
    capabilities: unknown
    compatible:   boolean
    missing:      string[]
  }

  if (!info.success) {
    throw new Error(`Agent "${name}" not found in registry`)
  }

  // ── Check host compatibility ──
  if (info.compatible === false) {
    throw new Error(
      `Agent "${name}" is not compatible with this host. ` +
      `Missing capabilities: ${info.missing.join(", ")}. ` +
      `This agent requires a Node.js host.`
    )
  }

  // Use the resolved version from the API (handles "latest" → actual semver)
  const resolvedVersion = info.version

  // ── Save to local storage ──
  const existing = await getInstalledAgent(name)

  if (existing) {
    bgLog.info(`Agent "${name}" already installed (v${existing.version}) — updating to v${resolvedVersion}`)
  } else {
    bgLog.info(`Installing agent "${name}" v${resolvedVersion}...`)
  }

  const agent: InstalledAgent = {
    name,
    version:      resolvedVersion,
    status:       "stopped",
    installed_at: Date.now(),
    config,
    // preserve existing instance_id if upgrading
    ...(existing?.instance_id !== undefined ? { instance_id: existing.instance_id } : {}),
  }

  await upsertInstalledAgent(agent)
  bgLog.info(`Agent "${name}" v${resolvedVersion} installed successfully`)
  return agent
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Uninstall an agent — removes metadata from storage.
 * Caller is responsible for stopping the runtime before calling this.
 */
export async function uninstallAgent(name: string): Promise<void> {
  const existing = await getInstalledAgent(name)
  if (!existing) {
    bgLog.warn(`Agent "${name}" is not installed — nothing to uninstall`)
    return
  }

  await removeInstalledAgent(name)
  bgLog.info(`Agent "${name}" uninstalled`)
}

// ─── Update config ────────────────────────────────────────────────────────────

export async function updateAgentConfig(
  name: string,
  config: Record<string, unknown>
): Promise<void> {
  const agent = await getInstalledAgent(name)
  if (!agent) throw new Error(`Agent "${name}" is not installed`)

  await upsertInstalledAgent({ ...agent, config })
  bgLog.info(`Agent "${name}" config updated`)
}
