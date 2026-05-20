/// <reference types="chrome" />

/**
 * Typed storage wrappers for chrome.storage.local.
 * All keys use the `lts_` prefix.
 */

import { STORAGE_KEYS } from "../constants"
import { InstalledAgent, TokenPair } from "../types"
import { agentLogKey, agentCtxKey } from "../utils/common"

export const KEYS = STORAGE_KEYS

export { agentLogKey, agentCtxKey }

export type { InstalledAgent, TokenPair }

// ─── Token helpers ────────────────────────────────────────────────────────────

export async function getTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
  const stored = await chrome.storage.local.get([KEYS.ACCESS_TOKEN, KEYS.REFRESH_TOKEN])
  return {
    accessToken:  stored[KEYS.ACCESS_TOKEN]  as string | undefined,
    refreshToken: stored[KEYS.REFRESH_TOKEN] as string | undefined,
  }
}

export async function saveTokens(accessToken: string, refreshToken?: string): Promise<void> {
  const data: Record<string, string> = { [KEYS.ACCESS_TOKEN]: accessToken }
  if (refreshToken) data[KEYS.REFRESH_TOKEN] = refreshToken
  await chrome.storage.local.set(data)
}

export async function clearTokens(): Promise<void> {
  await chrome.storage.local.remove([KEYS.ACCESS_TOKEN, KEYS.REFRESH_TOKEN])
}

// ─── Installed agents helpers ─────────────────────────────────────────────────

export async function getInstalledAgents(): Promise<InstalledAgent[]> {
  const stored = await chrome.storage.local.get(KEYS.INSTALLED_AGENTS)
  return (stored[KEYS.INSTALLED_AGENTS] as InstalledAgent[] | undefined) ?? []
}

export async function saveInstalledAgents(agents: InstalledAgent[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.INSTALLED_AGENTS]: agents })
}

export async function getInstalledAgent(name: string): Promise<InstalledAgent | undefined> {
  const agents = await getInstalledAgents()
  return agents.find(a => a.name === name)
}

export async function upsertInstalledAgent(agent: InstalledAgent): Promise<void> {
  const agents = await getInstalledAgents()
  const idx = agents.findIndex(a => a.name === agent.name)
  if (idx >= 0) {
    agents[idx] = agent
  } else {
    agents.push(agent)
  }
  await saveInstalledAgents(agents)
}

export async function removeInstalledAgent(name: string): Promise<void> {
  const agents = await getInstalledAgents()
  await saveInstalledAgents(agents.filter(a => a.name !== name))
}

export async function updateAgentStatus(
  name: string,
  status: InstalledAgent["status"],
  extra?: Partial<Pick<InstalledAgent, "alias" | "instance_id" | "run_id">>
): Promise<void> {
  const agents = await getInstalledAgents()
  const idx = agents.findIndex(a => a.name === name)
  if (idx >= 0) {
    agents[idx] = { ...agents[idx], status, ...extra }
    await saveInstalledAgents(agents)
  }
}

// ─── Agent ctx helpers ────────────────────────────────────────────────────────
// Persists the full ctx returned by /agents/run or /agents/restart.
// Equivalent to the AGENT_CTX env var that lifectl injects into the Node.js process.
// Survives SW termination — loaded back into _agentCtx on wake-up.

export async function saveAgentCtx(agentName: string, ctx: unknown): Promise<void> {
  await chrome.storage.local.set({ [agentCtxKey(agentName)]: ctx })
}

export async function getAgentCtx(agentName: string): Promise<unknown | undefined> {
  const key = agentCtxKey(agentName)
  const stored = await chrome.storage.local.get(key)
  return stored[key] as unknown | undefined
}

export async function removeAgentCtx(agentName: string): Promise<void> {
  await chrome.storage.local.remove(agentCtxKey(agentName))
}
