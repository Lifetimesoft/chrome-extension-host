/// <reference types="chrome" />

/**
 * Fetch wrapper with automatic token refresh.
 *
 * Mirrors lifectl's api-ai.ts interceptor pattern but for Chrome extensions:
 * - Reads access token from chrome.storage.local before each request
 * - On 401/406 response codes (SaaS app-main pattern), refreshes token and retries once
 * - Throws on unrecoverable auth failures
 */

import { getTokens, saveTokens } from "../storage/storage"

const AUTH_URL = "https://app.lifetimesoft.com/ex-api"

export interface ApiResponse<T = unknown> {
  success: boolean
  data:    T
  message?: string
  code?:   number
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshTokens(): Promise<string> {
  const { accessToken, refreshToken } = await getTokens()

  if (!refreshToken) {
    throw new Error("Unauthorized — no refresh token available")
  }

  const res = await fetch(`${AUTH_URL}/cli-login/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
  })

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status})`)
  }

  const data = await res.json() as { success: boolean; access_token?: string; refresh_token?: string; message?: string }

  if (!data.success || !data.access_token) {
    throw new Error(data.message ?? "Session expired — please log in again")
  }

  await saveTokens(data.access_token, data.refresh_token)
  return data.access_token
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {},
  _retried = false
): Promise<T> {
  const { accessToken } = await getTokens()

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  }

  if (accessToken) {
    headers["Authorization"] = accessToken
  }

  const res = await fetch(url, { ...options, headers })

  // Parse response body
  let body: ApiResponse<T>
  try {
    body = await res.json() as ApiResponse<T>
  } catch {
    if (!res.ok) {
      throw new Error(`Request failed (${res.status}): ${res.statusText}`)
    }
    throw new Error("Failed to parse response JSON")
  }

  // SaaS app-main returns HTTP 200 with body code 401/406 for auth errors
  const needsRefresh = body.code === 401 || body.code === 406

  if (needsRefresh && !_retried) {
    const newToken = await refreshTokens()

    // Retry with new token
    const retryHeaders: Record<string, string> = {
      ...headers,
      Authorization: newToken,
    }
    const retryRes = await fetch(url, { ...options, headers: retryHeaders })
    const retryBody = await retryRes.json() as ApiResponse<T>

    if (!retryBody.success) {
      throw new Error(retryBody.message ?? "Request failed after token refresh")
    }

    return retryBody.data
  }

  if (!body.success) {
    throw new Error(body.message ?? "Request failed")
  }

  return body.data
}

// ─── Convenience methods ──────────────────────────────────────────────────────

export const api = {
  get: <T = unknown>(url: string) =>
    apiFetch<T>(url, { method: "GET" }),

  post: <T = unknown>(url: string, body?: unknown) =>
    apiFetch<T>(url, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
}
