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
  removeAgentCtx,
  type InstalledAgent,
} from "../storage/storage"
import { apiCall } from "../utils/api-helper"
import { bgLog } from "../utils/logger"
import { API_URLS, AGENT_STATUS } from "../constants"
import type { AgentInfoResponse } from "../types"
import { retry } from "../utils/common"

export type { InstalledAgent }

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
  const isLatest = !version || version === "latest"
  const query = isLatest
    ? `?name=${encodeURIComponent(name)}&host=chrome`
    : `?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}&host=chrome`

  const res = await retry(() => apiCall(`${API_URLS.AGENT_BASE}/agents/info${query}`), 3, 1000)

  if (res.status === 404) {
    const body = await res.json() as { message?: string }
    throw new Error(body.message ?? `Agent "${name}" not found in registry`)
  }

  if (!res.ok) {
    throw new Error(`Registry check failed (${res.status})`)
  }

  const info = await res.json() as AgentInfoResponse

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
    status:       AGENT_STATUS.STOPPED,
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
 * Uninstall an agent — stops runtime, removes metadata from storage,
 * and deletes the instance from the SaaS platform (mirrors `lifectl ai agent rm`).
 * Caller is responsible for stopping the runtime before calling this.
 */
export async function uninstallAgent(name: string): Promise<void> {
  const existing = await getInstalledAgent(name)
  if (!existing) {
    bgLog.warn(`Agent "${name}" is not installed — nothing to uninstall`)
    return
  }

  // Notify SaaS to delete instance from D1 and clear DO storage — mirrors lifectl rm
  if (existing.run_id) {
    try {
      const res = await apiCall(`${API_URLS.AGENT_BASE}/agents/instance`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: existing.run_id }),
      })
      const data = await res.json() as { success: boolean; message?: string }
      if (!data.success) {
        bgLog.warn(`Agent "${name}" SaaS instance delete failed: ${data.message ?? "unknown"}`)
      }
    } catch {
      // best-effort — local cleanup proceeds regardless (instance will expire via TTL)
      bgLog.warn(`Agent "${name}" could not notify SaaS (offline?) — removing locally only`)
    }
  }

  await removeInstalledAgent(name)
  await removeAgentCtx(name)
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
