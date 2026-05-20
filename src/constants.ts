/**
 * Shared constants for chrome-extension-host
 */

// API URLs
export const API_URLS = {
  AUTH_BASE: "https://app.lifetimesoft.com/ex-api",
  AGENT_BASE: "https://app.lifetimesoft.com/cli/ai-account-management",
  WS_DEFAULT: "wss://app.lifetimesoft.com/cli/ai-account-management/agents/ws",
} as const

// Timing constants
export const TIMING = {
  HEARTBEAT_INTERVAL: 20_000,     // 20s
  RECONNECT_DELAY: 5_000,         // 5s
  POLL_INTERVAL: 3_000,           // 3s
  POLL_TIMEOUT: 5 * 60 * 1_000,   // 5min
  SANDBOX_TIMEOUT: 10 * 60 * 1_000, // 10min
  KEEPALIVE_INTERVAL: 20_000,     // 20s
} as const

// Storage keys
export const STORAGE_KEYS = {
  ACCESS_TOKEN: "lts_access_token",
  REFRESH_TOKEN: "lts_refresh_token",
  INSTALLED_AGENTS: "lts_installed_agents",
  AGENT_LOGS_PREFIX: "lts_logs_",
  AGENT_CTX_PREFIX: "lts_ctx_",
  LOGIN_STATE: "lts_login_pending",
} as const

// Alarm names
export const ALARMS = {
  KEEPALIVE: "lts_keepalive",
  LOGIN_POLL: "lts_login_poll",
  SCHEDULER_PREFIX: "lts_scheduler_",
} as const

// Agent status
export const AGENT_STATUS = {
  RUNNING: "running",
  STOPPED: "stopped", 
  ERROR: "error",
} as const

// Message types
export const MESSAGE_TYPES = {
  // Background messages
  AUTH_LOGIN: "auth_login",
  AUTH_LOGOUT: "auth_logout",
  AUTH_LOGIN_CANCEL: "auth_login_cancel",
  AGENT_START: "agent_start",
  AGENT_STOP: "agent_stop",
  AGENT_INSTALL: "agent_install",
  AGENT_UNINSTALL: "agent_uninstall",
  AGENT_UPDATE_ALIAS: "agent_update_alias",
  GET_STATUS: "get_status",
  
  // Runtime messages
  RUNTIME_DISCONNECT: "runtime_disconnect",
  RUNTIME_RECONNECT: "runtime_reconnect",
  
  // Navigation messages
  OPEN_DASHBOARD: "open_dashboard",
  OPEN_LOGS: "open_logs",
  
  // AI proxy messages
  AGENT_AI_CALL: "agent_ai_call",
  
  // Heartbeat messages
  HEARTBEAT_TRIGGER: "heartbeat_trigger",
  HEARTBEAT_CONFIG_UPDATED: "heartbeat_config_updated",
  
  // Offscreen messages
  OFFSCREEN_RUN: "offscreen_run",
  OFFSCREEN_STOP: "offscreen_stop",
  OFFSCREEN_LOG: "offscreen_log",
  OFFSCREEN_DONE: "offscreen_done",
  OFFSCREEN_ERROR: "offscreen_error",
  OFFSCREEN_KEEPALIVE: "offscreen_keepalive",
  OFFSCREEN_KEEPALIVE_START: "offscreen_keepalive_start",
  OFFSCREEN_KEEPALIVE_STOP: "offscreen_keepalive_stop",
  
  // Sandbox messages
  SANDBOX_RUN: "sandbox_run",
  SANDBOX_STOP: "sandbox_stop",
  SANDBOX_LOG: "sandbox_log",
  SANDBOX_DONE: "sandbox_done",
  SANDBOX_ERROR: "sandbox_error",
  SANDBOX_PROXY_REQUEST: "sandbox_proxy_request",
  SANDBOX_PROXY_RESPONSE: "sandbox_proxy_response",
} as const

// Default values
export const DEFAULTS = {
  ALARM_PREFIX: "lifetimesoft_agent",
  STORAGE_AREA: "local" as const,
  AGENT_BUNDLE_CACHE_SIZE: 50,
} as const
