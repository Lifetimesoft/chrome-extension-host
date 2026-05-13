/// <reference types="chrome" />

/**
 * Auth Service — device flow login/logout/refresh.
 *
 * Mirrors lifectl auth.ts but for Chrome extensions:
 * - login()  — device flow: init → open tab → poll → save tokens
 * - logout() — POST /ex-api/cli-logout + clear storage
 * - refreshTokenIfNeeded() — check JWT exp, refresh if expired
 */

import { getTokens, saveTokens, clearTokens } from "../storage/storage"
import { bgLog } from "../utils/logger"

const AUTH_URL = "https://app.lifetimesoft.com/ex-api"

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS  = 5 * 60 * 1_000

// ─── Login state persisted to storage ────────────────────────────────────────
// SW can be terminated during polling — persist device_code so we can resume

const LOGIN_STATE_KEY = "lts_login_pending"

interface LoginState {
  device_code: string
  deadline: number  // unix ms
}

async function saveLoginState(state: LoginState): Promise<void> {
  await chrome.storage.local.set({ [LOGIN_STATE_KEY]: state })
}

async function getLoginState(): Promise<LoginState | null> {
  const stored = await chrome.storage.local.get(LOGIN_STATE_KEY)
  return (stored[LOGIN_STATE_KEY] as LoginState | undefined) ?? null
}

async function clearLoginState(): Promise<void> {
  await chrome.storage.local.remove(LOGIN_STATE_KEY)
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
    return Math.floor(Date.now() / 1000) >= (payload.exp as number)
  } catch {
    return true
  }
}

// ─── Login flow ───────────────────────────────────────────────────────────────

let _loginAbort: AbortController | null = null

export async function login(): Promise<void> {
  // Cancel any in-progress login
  _loginAbort?.abort()
  _loginAbort = new AbortController()
  const signal = _loginAbort.signal

  // 1. Init — get device_code and login_url
  const initRes = await fetch(`${AUTH_URL}/cli-login/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "chrome" }),
  })

  if (!initRes.ok) throw new Error(`Login init failed (${initRes.status})`)

  const init = await initRes.json() as {
    success: boolean
    device_code?: string
    login_url?: string
    message?: string
  }

  if (!init.success || !init.device_code || !init.login_url) {
    throw new Error(init.message ?? "Login init returned no device_code")
  }

  const { device_code, login_url } = init
  const deadline = Date.now() + POLL_TIMEOUT_MS

  // 2. Persist login state so SW can resume polling after being terminated
  await saveLoginState({ device_code, deadline })

  // 3. Open login page in a new tab
  await chrome.tabs.create({ url: login_url })
  bgLog.info("Login page opened — waiting for user to authenticate...")

  // 4. Poll — use chrome.alarms to keep SW alive between polls
  await pollForToken(device_code, deadline, signal)
}

async function pollForToken(
  device_code: string,
  deadline: number,
  signal: AbortSignal
): Promise<void> {
  while (Date.now() < deadline) {
    if (signal.aborted) {
      await clearLoginState()
      throw new Error("Login cancelled")
    }

    // Use chrome.alarms to schedule next poll — keeps SW alive
    await new Promise<void>(resolve => {
      chrome.alarms.create("lts_login_poll", { delayInMinutes: POLL_INTERVAL_MS / 60_000 })
      chrome.alarms.onAlarm.addListener(function handler(alarm) {
        if (alarm.name === "lts_login_poll") {
          chrome.alarms.onAlarm.removeListener(handler)
          resolve()
        }
      })
    })

    if (signal.aborted) {
      await clearLoginState()
      throw new Error("Login cancelled")
    }

    const pollRes = await fetch(`${AUTH_URL}/cli-login/poll?device_code=${encodeURIComponent(device_code)}`)
    if (!pollRes.ok) continue

    const poll = await pollRes.json() as {
      status: "pending" | "completed" | "expired"
      access_token?: string
      refresh_token?: string
    }

    if (poll.status === "completed" && poll.access_token) {
      await saveTokens(poll.access_token, poll.refresh_token)
      await clearLoginState()
      bgLog.info("Login successful — tokens saved")
      // Notify popup
      chrome.runtime.sendMessage({ type: "login_complete" }).catch(() => {})
      return
    }

    if (poll.status === "expired") {
      await clearLoginState()
      throw new Error("Login session expired — please try again")
    }
  }

  await clearLoginState()
  throw new Error("Login timed out after 5 minutes")
}

/**
 * Resume polling if SW was terminated during a login flow.
 * Call this from bootstrap() on every SW wake-up.
 */
export async function resumeLoginIfPending(): Promise<void> {
  const state = await getLoginState()
  if (!state) return
  if (Date.now() >= state.deadline) {
    await clearLoginState()
    bgLog.warn("Pending login expired — cleared")
    return
  }

  bgLog.info("Resuming pending login poll...")
  const abort = new AbortController()
  _loginAbort = abort
  pollForToken(state.device_code, state.deadline, abort.signal).catch(e => {
    bgLog.error("Resumed login failed:", e instanceof Error ? e.message : String(e))
  })
}

export function cancelLogin(): void {
  _loginAbort?.abort()
  _loginAbort = null
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  const { refreshToken } = await getTokens()

  // Notify SaaS to invalidate the session — best-effort
  if (refreshToken) {
    await fetch(`${AUTH_URL}/cli-logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => { /* best-effort */ })
  }

  await clearTokens()
  bgLog.info("Logged out — tokens cleared")
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refreshTokenIfNeeded(): Promise<boolean> {
  const { accessToken, refreshToken } = await getTokens()

  if (!accessToken) return false

  // Token still valid — nothing to do
  if (!isTokenExpired(accessToken)) return true

  if (!refreshToken) {
    bgLog.warn("Access token expired but no refresh token available")
    return false
  }

  try {
    const res = await fetch(`${AUTH_URL}/cli-login/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
    })

    if (!res.ok) {
      bgLog.warn(`Token refresh failed (${res.status})`)
      return false
    }

    const data = await res.json() as {
      success: boolean
      access_token?: string
      refresh_token?: string
    }

    if (!data.success || !data.access_token) {
      bgLog.warn("Token refresh rejected by server")
      return false
    }

    await saveTokens(data.access_token, data.refresh_token ?? refreshToken)
    bgLog.info("Token refreshed successfully")
    return true
  } catch (e) {
    bgLog.error("Token refresh error:", e instanceof Error ? e.message : String(e))
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export { getTokens, saveTokens }

export async function isLoggedIn(): Promise<boolean> {
  const { accessToken } = await getTokens()
  return !!accessToken
}
