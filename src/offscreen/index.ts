/// <reference types="chrome" />

/**
 * Offscreen Document Script
 *
 * Acts as a bridge between the Background Service Worker and the Sandboxed iframe.
 *
 * Responsibilities:
 * 1. Forward run/stop commands from background → sandbox iframe
 * 2. Relay log messages from sandbox → background
 * 3. Handle chrome.* proxy calls from sandbox (storage, ai, queue)
 *    since the sandbox has no access to chrome.* APIs
 */

// ─── Sandbox iframe reference ─────────────────────────────────────────────────

const sandboxFrame = document.getElementById("sandbox-frame") as HTMLIFrameElement

function sendToSandbox(msg: object): void {
  sandboxFrame.contentWindow?.postMessage(msg, "*")
}

// ─── chrome.* proxy handlers ──────────────────────────────────────────────────
// The sandbox calls these via postMessage since it has no chrome.* access

const REGISTRY_BASE = "https://registry.lifetimesoft.com"
const APP_BASE      = "https://app.lifetimesoft.com/cli/ai-account-management"

async function handleProxyCall(
  agentName: string,
  api: string,
  method: string,
  args: unknown[]
): Promise<unknown> {

  // ── storage ──
  if (api === "storage") {
    const prefix = `lts_agent_storage_${agentName}_`

    if (method === "get") {
      const key = prefix + (args[0] as string)
      const stored = await chrome.storage.local.get(key)
      const entry = stored[key] as { value: unknown; exp?: number } | undefined
      if (!entry) return null
      if (entry.exp && Date.now() > entry.exp) {
        await chrome.storage.local.remove(key)
        return null
      }
      return entry.value
    }

    if (method === "set") {
      const key   = prefix + (args[0] as string)
      const value = args[1]
      const opts  = args[2] as { ttl?: number } | undefined
      const entry: { value: unknown; exp?: number } = { value }
      if (opts?.ttl) entry.exp = Date.now() + opts.ttl * 1000
      await chrome.storage.local.set({ [key]: entry })
      return null
    }

    if (method === "delete") {
      const key = prefix + (args[0] as string)
      await chrome.storage.local.remove(key)
      return null
    }
  }

  // ── queue ──
  if (api === "queue" && method === "push") {
    // Relay to background as a message — background handles the actual queue push
    chrome.runtime.sendMessage({ type: "agent_queue_push", agentName, data: args[0] }).catch(() => {})
    return null
  }

  // ── ai ──
  if (api === "ai") {
    // Relay AI calls to background which has the access token and proper fetch permissions
    const res = await chrome.runtime.sendMessage({
      type: "agent_ai_call",
      agentName,
      method,
      args,
    }) as { success: boolean; result?: unknown; error?: string }

    if (!res.success) throw new Error(res.error ?? "AI call failed")
    return res.result
  }

  throw new Error(`Unknown proxy call: ${api}.${method}`)
}

// ─── Message handler: sandbox → offscreen ────────────────────────────────────

window.addEventListener("message", async (event) => {
  const msg = event.data as Record<string, unknown>
  if (!msg || typeof msg !== "object") return

  // Log from sandbox → forward to background
  if (msg.type === "sandbox_log") {
    chrome.runtime.sendMessage({
      type:      "offscreen_log",
      agentName: msg.agentName,
      level:     msg.level,
      args:      msg.args,
    }).catch(() => {})
    return
  }

  // Agent run completed
  if (msg.type === "sandbox_done") {
    chrome.runtime.sendMessage({
      type:      "offscreen_done",
      agentName: msg.agentName,
      requestId: msg.requestId,
    }).catch(() => {})
    return
  }

  // Agent run errored
  if (msg.type === "sandbox_error") {
    chrome.runtime.sendMessage({
      type:      "offscreen_error",
      agentName: msg.agentName,
      requestId: msg.requestId,
      error:     msg.error,
    }).catch(() => {})
    return
  }

  // Proxy request: sandbox needs a chrome.* call
  if (msg.type === "sandbox_proxy_request") {
    const { agentName, requestId, api, method, args } = msg as {
      agentName: string
      requestId: string
      api:       string
      method:    string
      args:      unknown[]
    }

    try {
      const result = await handleProxyCall(agentName, api, method, args)
      sendToSandbox({ type: "sandbox_proxy_response", requestId, result })
    } catch (e) {
      sendToSandbox({
        type:      "sandbox_proxy_response",
        requestId,
        error:     e instanceof Error ? e.message : String(e),
      })
    }
    return
  }
})

// ─── Message handler: background → offscreen ─────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message !== "object" || message === null) return

  // Forward run command to sandbox
  if (message.type === "offscreen_run") {
    sendToSandbox({
      type:         "sandbox_run",
      agentName:    message.agentName,
      code:         message.code,
      agentCtx:     message.agentCtx,
      accessToken:  message.accessToken,
      refreshToken: message.refreshToken,
      requestId:    message.requestId,
    })
    return
  }

  // Forward stop command to sandbox
  if (message.type === "offscreen_stop") {
    sendToSandbox({
      type:      "sandbox_stop",
      agentName: message.agentName,
    })
    return
  }
})
