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
  getInstalledAgents,
  upsertInstalledAgent,
  updateAgentStatus,
  getTokens,
  saveAgentCtx,
  getAgentCtx,
  removeAgentCtx,
} from "../storage/storage"
import { apiCall } from "../utils/api-helper"
import { bgLog } from "../utils/logger"
import { runInSandbox, stopInSandbox, notifyOffscreenKeepaliveStart, notifyOffscreenKeepaliveStop } from "./sandbox.service"
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
  agentVersion: string
): Promise<{ ctx: Pick<Context, "input" | "config" | "env" | "meta">; instance_id: number }> {
  const res = await apiCall(`${BASE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  instanceId: number
): Promise<{ ctx: Pick<Context, "input" | "config" | "env" | "meta"> }> {
  const res = await apiCall(`${BASE_URL}/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  bgLog.info(`Starting agent "${agentName}" v${agent.version} via sandbox...`)

  let agentCtx: Pick<Context, "input" | "config" | "env" | "meta">
  let instanceId: number | undefined = agent.instance_id

  try {
    if (instanceId !== undefined) {
      bgLog.info(`Restarting existing instance ${instanceId} for "${agentName}"...`)
      try {
        const { ctx } = await restartRun(instanceId)
        agentCtx = ctx
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === "INSTANCE_EXPIRED") {
          bgLog.info(`Instance expired for "${agentName}" — registering new run...`)
          const { ctx, instance_id } = await registerRun(agentName, agent.version)
          agentCtx = ctx
          instanceId = instance_id
        } else {
          throw e
        }
      }
    } else {
      bgLog.info(`Registering new run for "${agentName}"...`)
      const { ctx, instance_id } = await registerRun(agentName, agent.version)
      agentCtx = ctx
      instanceId = instance_id
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    bgLog.error(`Failed to get ctx for "${agentName}":`, msg)
    await updateAgentStatus(agentName, "error")
    throw e
  }

  // Update stored metadata — persist ws_url so keepalive alarm can reconnect after SW restart
  await upsertInstalledAgent({
    ...agent,
    instance_id: instanceId,
    run_id:      agentCtx.meta.run_id,
    ws_url:      agentCtx.meta.runtime?.ws_url,
    status:      "running",
  })

  // Persist ctx to chrome.storage — equivalent to AGENT_CTX env var in Node.js runtime.
  // Survives SW termination so trigger/config_updated can run agent without full restart.
  await saveAgentCtx(agentName, agentCtx)

  bgLog.info(`Got ctx for "${agentName}" — run_id: ${agentCtx.meta.run_id}`)

  _running.add(agentName)

  // Cache ctx for in-process trigger/config_updated handling
  _agentCtx.set(agentName, agentCtx)

  // Start keepalive ping from offscreen when first agent starts
  if (_running.size === 1) {
    notifyOffscreenKeepaliveStart()
  }

  // Start WebSocket heartbeat and wait for it to open before dispatching to sandbox.
  // This ensures the DO has an active WS connection before the agent run completes
  // and the user can trigger it from the SaaS dashboard.
  if (agentCtx.meta.run_id) {
    await startHeartbeat(agentName, agentCtx.meta.run_id, agentCtx.meta.runtime?.ws_url)
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
      if (_running.size === 0) notifyOffscreenKeepaliveStop()
      updateAgentStatus(agentName, "stopped").catch(() => {})
    }
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    bgLog.error(`Agent "${agentName}" sandbox run failed:`, msg)
    if (_running.has(agentName)) {
      _running.delete(agentName)
      _agentCtx.delete(agentName)
      if (_running.size === 0) notifyOffscreenKeepaliveStop()
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
  await removeAgentCtx(agentName)

  // Stop keepalive ping when last agent stops
  if (_running.size === 0) {
    notifyOffscreenKeepaliveStop()
  }

  // Notify platform so DO marks agent as STOPPED (not just OFFLINE via WS close)
  if (agent?.run_id) {
    await notifyStopped(agent.run_id)
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

async function notifyStopped(runId: string): Promise<void> {
  try {
    await apiCall(`${BASE_URL}/stopped`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, last_error: null }),
    })
  } catch {
    // best-effort — DO will detect OFFLINE via WebSocket close anyway
  }
}

// ─── Force stop (for uninstall when SW was restarted) ────────────────────────

/**
 * Stop an agent that may be running but whose state is only in storage (SW restarted).
 * Used before uninstall to ensure heartbeat is stopped and platform is notified.
 * Safe to call even if agent is not running — no-op in that case.
 */
export async function forceStopIfRunning(agentName: string): Promise<void> {
  const agent = await getInstalledAgent(agentName)
  if (!agent || agent.status !== "running") return

  bgLog.info(`forceStop: "${agentName}" — stopping heartbeat and notifying platform`)

  if (agent.run_id) {
    stopHeartbeat(agent.run_id)
  }

  await updateAgentStatus(agentName, "stopped")
  await removeAgentCtx(agentName)

  const { accessToken } = await getTokens()
  if (accessToken && agent.run_id) {
    await notifyStopped(agent.run_id)
  }

  if (_running.size === 0) {
    notifyOffscreenKeepaliveStop()
  }
}

// ─── Reconnect heartbeats after SW wake-up ───────────────────────────────────

/**
 * Restore a single agent after SW restart — load ctx from storage and reconnect WS.
 * Does NOT call /agents/restart — avoids unnecessary API calls on every SW wake-up.
 * Falls back to full startAgent() only if ctx is missing from storage.
 */
export async function restoreAgent(agentName: string): Promise<void> {
  const agent = await getInstalledAgent(agentName)
  if (!agent?.run_id) {
    bgLog.warn(`restoreAgent: "${agentName}" has no run_id — doing full start`)
    await startAgent(agentName)
    return
  }

  const stored = await getAgentCtx(agentName) as Pick<Context, "input" | "config" | "env" | "meta"> | undefined
  if (!stored) {
    bgLog.warn(`restoreAgent: "${agentName}" has no stored ctx — doing full start`)
    await startAgent(agentName)
    return
  }

  bgLog.info(`restoreAgent: "${agentName}" — restoring ctx from storage, reconnecting WS`)
  _agentCtx.set(agentName, stored)
  _running.add(agentName)

  // Start keepalive ping from offscreen when first agent is restored
  if (_running.size === 1) {
    notifyOffscreenKeepaliveStart()
  }

  await startHeartbeat(agentName, agent.run_id, agent.ws_url)
}

/**
 * Called by the keepalive alarm every minute.
 * Reconnects WebSocket heartbeats for all agents that are stored as "running"
 * but whose WS connection was dropped when the SW was terminated.
 */
export async function reconnectHeartbeats(): Promise<void> {
  const agents = await getInstalledAgents()
  const runningAgents = agents.filter(a => a.status === "running")

  for (const agent of runningAgents) {
    if (!agent.run_id) continue

    // Restore ctx into memory if SW was restarted and _agentCtx is empty
    if (!_agentCtx.has(agent.name)) {
      const stored = await getAgentCtx(agent.name) as Pick<Context, "input" | "config" | "env" | "meta"> | undefined
      if (stored) {
        _agentCtx.set(agent.name, stored)
        _running.add(agent.name)
        if (_running.size === 1) notifyOffscreenKeepaliveStart()
      }
    }

    // startHeartbeat is idempotent — skips if connection already active for this run_id
    await startHeartbeat(agent.name, agent.run_id, agent.ws_url)
  }
}

/**
 * Run the agent once in sandbox using the existing ctx — no new API call.
 * Mirrors what runtime-chrome.ts does on WS trigger message.
 */
export async function triggerAgent(agentName: string): Promise<void> {
  const agent = await getInstalledAgent(agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" is not installed`)
  }

  // Try in-memory first (SW still alive), then fall back to persisted storage
  // (SW was restarted — equivalent to Node.js reading AGENT_CTX from process.env)
  let agentCtx = _agentCtx.get(agentName)
  
  if (!agentCtx) {
    const stored = await getAgentCtx(agentName) as Pick<Context, "input" | "config" | "env" | "meta"> | undefined
    if (stored) {
      bgLog.info(`Trigger for "${agentName}" — restoring ctx from storage (SW was restarted)`)
      agentCtx = stored
      _agentCtx.set(agentName, agentCtx)
      // Reconnect heartbeat since SW memory was cleared
      if (agentCtx.meta.run_id) {
        await startHeartbeat(agentName, agentCtx.meta.run_id, agentCtx.meta.runtime?.ws_url)
      }
    } else {
      bgLog.info(`Trigger for "${agentName}" — no ctx in storage, doing full start`)
      await startAgent(agentName)
      return
    }
  }

  bgLog.info(`Trigger: running "${agentName}" in sandbox`)

  runInSandbox({
    agentName,
    agentVersion: agent.version,
    agentCtx,
  }).then(() => {
    bgLog.info(`Trigger: "${agentName}" completed`)
  }).catch((e: unknown) => {
    bgLog.error(`Trigger: "${agentName}" failed:`, e instanceof Error ? e.message : String(e))
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
  // Try in-memory first, then fall back to persisted storage
  let agentCtx = _agentCtx.get(agentName)
  if (!agentCtx) {
    const stored = await getAgentCtx(agentName) as Pick<Context, "input" | "config" | "env" | "meta"> | undefined
    if (!stored) {
      bgLog.warn(`config_updated for "${agentName}" — no ctx in memory or storage, skipping`)
      return
    }
    agentCtx = stored
  }

  // Update ctx — same as runtime-chrome.ts onWsMessage config_updated
  agentCtx.config = config as Context["config"]
  if ((config as { env?: Record<string, unknown> }).env) {
    agentCtx.env = (config as { env: Record<string, unknown> }).env
  }

  // Persist updated ctx back to storage so next SW wake-up gets the new config
  _agentCtx.set(agentName, agentCtx)
  await saveAgentCtx(agentName, agentCtx)

  bgLog.info(`config_updated applied for "${agentName}" — ctx updated in memory and storage`)
}
