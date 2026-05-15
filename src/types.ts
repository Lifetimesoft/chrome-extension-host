/**
 * Shared type definitions for chrome-extension-host
 */

import { AGENT_STATUS } from "./constants"

// Agent types
export interface InstalledAgent {
  name: string
  version: string
  status: "running" | "stopped" | "error"
  instance_id?: number
  run_id?: string
  ws_url?: string
  installed_at: number
  config: Record<string, unknown>
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface LoginState {
  device_code: string
  deadline: number
}

// Scheduler types
export interface SchedulerConfig {
  type: "none" | "interval" | "cron"
  value?: number | string
}

// Message types
export interface BackgroundMessage {
  type: string
  [key: string]: unknown
}

export interface HeartbeatMessage extends BackgroundMessage {
  type: "heartbeat_trigger" | "heartbeat_config_updated"
  agentName: string
  runId: string
  config?: Record<string, unknown>
}

export interface OffscreenMessage extends BackgroundMessage {
  type: "offscreen_run" | "offscreen_stop" | "offscreen_log" | "offscreen_done" | "offscreen_error"
  agentName?: string
  requestId?: string
  jobId?: string
  level?: "info" | "warn" | "error" | "debug"
  args?: string[]
  error?: string
}

export interface SandboxMessage extends BackgroundMessage {
  type: "sandbox_run" | "sandbox_stop" | "sandbox_log" | "sandbox_done" | "sandbox_error" | "sandbox_proxy_request" | "sandbox_proxy_response"
  agentName?: string
  requestId?: string
  jobId?: string
  code?: string
  agentCtx?: object
  accessToken?: string
  refreshToken?: string
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

export interface AgentInfoResponse {
  success: boolean
  name: string
  version: string
  latest_version: string
  description: string
  capabilities: unknown
  compatible: boolean
  missing: string[]
}

export interface TokenRefreshResponse {
  success: boolean
  access_token?: string
  refresh_token?: string
  message?: string
}

// Runtime types
export interface HeartbeatConnection {
  ws: WebSocket | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  stopped: boolean
  agentName: string
  wsUrl: string
}

export interface PendingRun {
  resolve: () => void
  reject: (error: Error) => void
}

export interface SandboxRunOptions {
  agentName: string
  agentVersion: string
  agentCtx: object
}

// Error types
export class ExtensionError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = "ExtensionError"
  }
}

export class AuthError extends ExtensionError {
  constructor(message: string, details?: unknown) {
    super(message, "AUTH_ERROR", details)
    this.name = "AuthError"
  }
}

export class AgentError extends ExtensionError {
  constructor(message: string, details?: unknown) {
    super(message, "AGENT_ERROR", details)
    this.name = "AgentError"
  }
}

export class SandboxError extends ExtensionError {
  constructor(message: string, details?: unknown) {
    super(message, "SANDBOX_ERROR", details)
    this.name = "SandboxError"
  }
}