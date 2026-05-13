/// <reference types="chrome" />

/**
 * Runtime Service — manages running agent instances.
 *
 * Mirrors how lifectl manages containers:
 * - startAgent(name) — POST /agents/run or /agents/restart → createChromeRuntime → runtime.start()
 * - stopAgent(name)  — runtime.stop()
 * - getStatus(name)  — running/stopped/error
 *
 * Stores ChromeRuntimeHandle per agent in a Map.
 */

import { createChromeRuntime, type ChromeRuntimeHandle } from "@lifetimesoft/agent-sdk/runtime-chrome"
import type { Context, Agent } from "@lifetimesoft/agent-sdk"
import {
  getInstalledAgent,
  upsertInstalledAgent,
  updateAgentStatus,
  getTokens,
} from "../storage/storage"
import { createLogger, bgLog } from "../utils/logger"

const BASE_URL = "https://app.lifetimesoft.com/cli/ai-account-management"

// ─── Runtime registry ─────────────────────────────────────────────────────────

const _runtimes = new Map<string, ChromeRuntimeHandle>()

// ─── SaaS API calls ───────────────────────────────────────────────────────────

function getClientInfo() {
  return {
    type:             "chrome",
    manifest_version: 3,
    extension_version: chrome.runtime.getManifest().version,
  }
}

async function registerRun(
  agentName: string,
  agentVersion: string,
  accessToken: string
): Promise<{ ctx: Pick<Context, "input" | "config" | "env" | "meta">; instance_id: number }> {
  const res = await fetch(`${BASE_URL}/agents/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({
      agent_name:    agentName,
      agent_version: agentVersion,
      container_id:  `chrome-${Date.now()}`,
      hostname:      "chrome-extension",
      client_info:   getClientInfo(),
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`/agents/run failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    success: boolean
    ctx?: Pick<Context, "input" | "config" | "env" | "meta">
    message?: string
  }

  if (!data.success || !data.ctx) {
    throw new Error(`/agents/run rejected: ${data.message ?? "no ctx"}`)
  }

  // instance_id is encoded in run_id as the 3rd segment: "run_{agentId}_{instanceId}_{ts}"
  const instance_id = parseInt((data.ctx.meta.run_id ?? "").split("_")[2], 10)
  return { ctx: data.ctx, instance_id }
}

async function restartRun(
  instanceId: number,
  accessToken: string
): Promise<{ ctx: Pick<Context, "input" | "config" | "env" | "meta"> }> {
  const res = await fetch(`${BASE_URL}/agents/restart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({
      instance_id:  instanceId,
      container_id: `chrome-${Date.now()}`,
      hostname:     "chrome-extension",
      client_info:  getClientInfo(),
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`/agents/restart failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    success: boolean
    expired?: boolean
    ctx?: Pick<Context, "input" | "config" | "env" | "meta">
    message?: string
  }

  if (!data.success) {
    if (data.expired) throw new Error("INSTANCE_EXPIRED")
    throw new Error(`/agents/restart rejected: ${data.message ?? "unknown"}`)
  }

  if (!data.ctx) throw new Error("/agents/restart returned no ctx")
  return { ctx: data.ctx }
}

// ─── Start agent ──────────────────────────────────────────────────────────────

export async function startAgent(agentName: string): Promise<void> {
  // Stop any existing runtime for this agent first
  await stopAgent(agentName)

  const agent = await getInstalledAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" is not installed`)

  const { accessToken, refreshToken } = await getTokens()
  if (!accessToken) throw new Error("Not logged in — please authenticate first")

  bgLog.info(`Starting agent "${agentName}" v${agent.version}...`)

  let agentCtx: Pick<Context, "input" | "config" | "env" | "meta">
  let instanceId: number | undefined = agent.instance_id

  try {
    if (instanceId !== undefined) {
      bgLog.info(`Restarting existing instance ${instanceId} for "${agentName}"...`)
      try {
        const { ctx } = await restartRun(instanceId, accessToken)
        agentCtx = ctx
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === "INSTANCE_EXPIRED") {
          bgLog.info(`Instance expired for "${agentName}" — registering new run...`)
          const { ctx, instance_id } = await registerRun(agentName, agent.version, accessToken)
          agentCtx = ctx
          instanceId = instance_id
        } else {
          throw e
        }
      }
    } else {
      bgLog.info(`Registering new run for "${agentName}"...`)
      const { ctx, instance_id } = await registerRun(agentName, agent.version, accessToken)
      agentCtx = ctx
      instanceId = instance_id
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    bgLog.error(`Failed to get ctx for "${agentName}":`, msg)
    await updateAgentStatus(agentName, "error")
    throw e
  }

  // Update stored metadata with new instance/run info
  await upsertInstalledAgent({
    ...agent,
    instance_id: instanceId,
    run_id:      agentCtx.meta.run_id,
    status:      "running",
  })

  bgLog.info(`Got ctx for "${agentName}" — run_id: ${agentCtx.meta.run_id}`)

  // Create per-agent logger and attach to ctx
  const agentLogger = createLogger(agentName)
  const agentCtxWithLog = {
    ...agentCtx,
    log: agentLogger,
  } as typeof agentCtx

  // Dynamically import the agent module
  // Agents are expected to be installed as named modules or bundled
  // For the host, we use a dynamic import pattern
  let agentModule: { default: unknown }
  try {
    // Agents are loaded by name — they must be registered in the host bundle
    agentModule = await loadAgentModule(agentName)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    bgLog.error(`Failed to load agent module "${agentName}":`, msg)
    await updateAgentStatus(agentName, "error")
    throw new Error(`Cannot load agent module "${agentName}": ${msg}`)
  }

  const handle = createChromeRuntime(agentModule.default as Agent, {
    agentCtx:    agentCtxWithLog,
    accessToken,
    refreshToken,
    storageArea: "local",
    alarmPrefix: `lts_agent_${agentName}`,
  })

  _runtimes.set(agentName, handle)

  await handle.start()
  bgLog.info(`Agent "${agentName}" runtime started`)
}

// ─── Stop agent ───────────────────────────────────────────────────────────────

export async function stopAgent(agentName: string): Promise<void> {
  const handle = _runtimes.get(agentName)
  if (!handle) return

  bgLog.info(`Stopping agent "${agentName}"...`)
  await handle.stop().catch(() => { /* best-effort */ })
  _runtimes.delete(agentName)
  await updateAgentStatus(agentName, "stopped")
  bgLog.info(`Agent "${agentName}" stopped`)
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function isAgentRunning(agentName: string): boolean {
  return _runtimes.has(agentName)
}

export async function getStatus(agentName: string): Promise<"running" | "stopped" | "error"> {
  if (_runtimes.has(agentName)) return "running"
  const agent = await getInstalledAgent(agentName)
  return agent?.status ?? "stopped"
}

// ─── Stop all ─────────────────────────────────────────────────────────────────

export async function stopAllAgents(): Promise<void> {
  const names = Array.from(_runtimes.keys())
  await Promise.all(names.map(name => stopAgent(name)))
}

// ─── Agent module loader ──────────────────────────────────────────────────────

/**
 * Load an agent module by name.
 *
 * In the host extension, agents are bundled separately and registered
 * via a registry. This function looks up the registry and returns the module.
 *
 * The registry is populated by the build process or by dynamic installation.
 */
const _agentRegistry = new Map<string, { default: unknown }>()

export function registerAgentModule(name: string, module: { default: unknown }): void {
  _agentRegistry.set(name, module)
}

async function loadAgentModule(name: string): Promise<{ default: unknown }> {
  const mod = _agentRegistry.get(name)
  if (!mod) {
    throw new Error(
      `Agent "${name}" is not registered. ` +
      `Call registerAgentModule("${name}", module) before starting the agent.`
    )
  }
  return mod
}
