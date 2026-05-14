/// <reference types="chrome" />

/**
 * Runtime Service — manages running agent instances.
 *
 * Mirrors how lifectl manages containers:
 * - startAgent(name) — POST /agents/run or /agents/restart → runInSandbox()
 * - stopAgent(name)  — stopInSandbox()
 * - getStatus(name)  — running/stopped/error
 *
 * Agent code is fetched from the registry and executed inside a sandboxed
 * iframe via the offscreen document. This bypasses MV3's eval() restriction
 * while keeping agent code isolated from the extension's chrome.* APIs.
 */

import type { Context } from "@lifetimesoft/agent-sdk"
import {
  getInstalledAgent,
  upsertInstalledAgent,
  updateAgentStatus,
  getTokens,
} from "../storage/storage"
import { bgLog } from "../utils/logger"
import { runInSandbox, stopInSandbox } from "./sandbox.service"
import { startHeartbeat, stopHeartbeat } from "./heartbeat.service"

const BASE_URL = "https://app.lifetimesoft.com/cli/ai-account-management/agents"

// ─── Runtime registry ─────────────────────────────────────────────────────────
// Track which agents are currently running (in sandbox)

const _running = new Set<string>()

// Track agentCtx per running agent — needed for in-process trigger/config_updated
const _agentCtx = new Map<string, Pick<Context, "input" | "config" | "env" | "meta">>()

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
  const res = await fetch(`${BASE_URL}/run`, {
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
  const res = await fetch(`${BASE_URL}/restart`, {
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
  // Stop any existing run first
  await stopAgent(agentName)

  const agent = await getInstalledAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" is not installed`)

  const { accessToken } = await getTokens()
  if (!accessToken) throw new Error("Not logged in — please authenticate first")

  bgLog.info(`Starting agent "${agentName}" v${agent.version} via sandbox...`)

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

  // Update stored metadata
  await upsertInstalledAgent({
    ...agent,
    instance_id: instanceId,
    run_id:      agentCtx.meta.run_id,
    status:      "running",
  })

  bgLog.info(`Got ctx for "${agentName}" — run_id: ${agentCtx.meta.run_id}`)

  _running.add(agentName)

  // Cache ctx for in-process trigger/config_updated handling
  _agentCtx.set(agentName, agentCtx)

  // Start WebSocket heartbeat so the DO knows the agent is alive
  if (agentCtx.meta.run_id) {
    startHeartbeat(agentName, agentCtx.meta.run_id, agentCtx.meta.runtime?.ws_url)
  }

  // Run agent in sandbox — fire and forget (scheduler handles repeats via alarms)
  runInSandbox({
    agentName,
    agentVersion: agent.version,
    agentCtx,
  }).then(() => {
    bgLog.info(`Agent "${agentName}" sandbox run completed`)
    // Only mark stopped if not already stopped by stopAgent()
    if (_running.has(agentName)) {
      _running.delete(agentName)
      _agentCtx.delete(agentName)
      updateAgentStatus(agentName, "stopped").catch(() => {})
    }
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    bgLog.error(`Agent "${agentName}" sandbox run failed:`, msg)
    if (_running.has(agentName)) {
      _running.delete(agentName)
      _agentCtx.delete(agentName)
      updateAgentStatus(agentName, "error").catch(() => {})
    }
  })

  bgLog.info(`Agent "${agentName}" dispatched to sandbox`)
}

// ─── Stop agent ───────────────────────────────────────────────────────────────

export async function stopAgent(agentName: string): Promise<void> {
  if (!_running.has(agentName)) return

  bgLog.info(`Stopping agent "${agentName}"...`)
  _running.delete(agentName)
  _agentCtx.delete(agentName)

  // Stop heartbeat before stopping sandbox so DO gets notified cleanly
  const agent = await getInstalledAgent(agentName)
  if (agent?.run_id) {
    stopHeartbeat(agent.run_id)
  }

  await stopInSandbox(agentName)
  await updateAgentStatus(agentName, "stopped")

  // Notify platform so DO marks agent as STOPPED (not just OFFLINE via WS close)
  const { accessToken } = await getTokens()
  if (accessToken && agent?.run_id) {
    await notifyStopped(agent.run_id, accessToken)
  }

  bgLog.info(`Agent "${agentName}" stopped`)
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function isAgentRunning(agentName: string): boolean {
  return _running.has(agentName)
}

export async function getStatus(agentName: string): Promise<"running" | "stopped" | "error"> {
  if (_running.has(agentName)) return "running"
  const agent = await getInstalledAgent(agentName)
  return agent?.status ?? "stopped"
}

// ─── Stop all ─────────────────────────────────────────────────────────────────

export async function stopAllAgents(): Promise<void> {
  const names = Array.from(_running)
  await Promise.all(names.map(name => stopAgent(name)))
}

// ─── Notify platform agent stopped ───────────────────────────────────────────

async function notifyStopped(runId: string, accessToken: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/stopped`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: accessToken,
      },
      body: JSON.stringify({ run_id: runId, last_error: null }),
    })
  } catch {
    // best-effort — DO will detect OFFLINE via WebSocket close anyway
  }
}

// ─── In-process trigger (scheduler type: none) ────────────────────────────────

/**
 * Run the agent once in sandbox using the existing ctx — no new API call.
 * Mirrors what runtime-chrome.ts does on WS trigger message.
 */
export async function triggerAgent(agentName: string): Promise<void> {
  const agent = await getInstalledAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" is not installed`)

  const agentCtx = _agentCtx.get(agentName)
  if (!agentCtx) {
    bgLog.warn(`Trigger for "${agentName}" — no ctx in memory, falling back to full restart`)
    await startAgent(agentName)
    return
  }

  bgLog.info(`Trigger: running "${agentName}" in sandbox (in-process)`)
  runInSandbox({
    agentName,
    agentVersion: agent.version,
    agentCtx,
  }).then(() => {
    bgLog.info(`Trigger: "${agentName}" sandbox run completed`)
  }).catch((e: unknown) => {
    bgLog.error(`Trigger: "${agentName}" sandbox run failed:`, e instanceof Error ? e.message : String(e))
  })
}

// ─── In-process config update ─────────────────────────────────────────────────

/**
 * Apply new config to the running agent ctx and re-run in sandbox.
 * Mirrors what runtime-chrome.ts does on WS config_updated message.
 */
export async function applyConfigUpdate(
  agentName: string,
  config: Record<string, unknown>
): Promise<void> {
  const agentCtx = _agentCtx.get(agentName)
  if (!agentCtx) {
    bgLog.warn(`config_updated for "${agentName}" — no ctx in memory, skipping in-process update`)
    return
  }

  // update ctx in-memory — same as runtime-chrome.ts onWsMessage config_updated
  agentCtx.config = config as Context["config"]
  if ((config as { env?: Record<string, unknown> }).env) {
    agentCtx.env = (config as { env: Record<string, unknown> }).env
  }
  _agentCtx.set(agentName, agentCtx)

  bgLog.info(`config_updated applied for "${agentName}" — ctx updated in memory`)
}
