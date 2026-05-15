/// <reference types="chrome" />

/**
 * API Helper with automatic token refresh
 * 
 * Mirrors lifectl's axios interceptor behavior:
 * 1. Make API call with current token
 * 2. If 401/406 response, refresh token and retry
 * 3. Throw error if refresh fails
 */

import { getTokens, saveTokens } from "../storage/storage"
import { bgLog } from "./logger"

const AUTH_URL = "https://app.lifetimesoft.com/ex-api"

export async function apiCall(url: string, options: RequestInit = {}): Promise<Response> {
  const { accessToken, refreshToken } = await getTokens()
  if (!accessToken) throw new Error("Not logged in — please authenticate first")

  // First attempt with current token
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: accessToken,
    },
  })

  // Clone response to read body without consuming it
  const responseClone = response.clone()
  
  // Check response body for auth errors (mirrors lifectl behavior)
  let needsRefresh = false
  try {
    const data = await responseClone.json()
    // app-main AuthCli always returns HTTP 200 with body:
    //   { code: 401, success: false } → invalid token (bad signature)
    //   { code: 406, success: false } → expired token
    needsRefresh = data?.code === 401 || data?.code === 406
  } catch {
    // If response is not JSON, fall back to HTTP status check
    needsRefresh = response.status === 401 || response.status === 406
  }

  if (needsRefresh) {
    if (!refreshToken) {
      throw new Error("Session expired — please log in again")
    }

    try {
      bgLog.info("Token expired, refreshing...")
      
      // Refresh token
      const refreshRes = await fetch(`${AUTH_URL}/cli-login/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          access_token: accessToken, 
          refresh_token: refreshToken 
        }),
      })

      if (!refreshRes.ok) {
        throw new Error("Token refresh failed")
      }

      const refreshData = await refreshRes.json() as {
        success: boolean
        access_token?: string
        refresh_token?: string
        message?: string
      }

      if (!refreshData.success || !refreshData.access_token) {
        throw new Error(refreshData.message || "Token refresh rejected by server")
      }

      // Save new tokens
      await saveTokens(refreshData.access_token, refreshData.refresh_token ?? refreshToken)
      bgLog.info("Token refreshed successfully")

      // Retry original request with new token
      return fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: refreshData.access_token,
        },
      })
    } catch (e) {
      bgLog.error("Token refresh error:", e instanceof Error ? e.message : String(e))
      throw new Error("Authentication failed — please log in again")
    }
  }

  return response
}