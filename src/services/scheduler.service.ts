/// <reference types="chrome" />

/**
 * Scheduler Service for Chrome Extension
 * 
 * Handles agent scheduling using chrome.alarms API
 * Supports: none (manual trigger), interval, and cron scheduling
 */

import { bgLog } from "../utils/logger"
import { triggerAgent } from "./runtime.service"
import { getInstalledAgent } from "../storage/storage"

interface SchedulerConfig {
  type: "none" | "interval" | "cron"
  value?: number | string
}

// Track active schedulers per agent
const _activeSchedulers = new Map<string, { config: SchedulerConfig; alarmName: string }>()

/**
 * Start scheduler for an agent
 */
export function startScheduler(agentName: string, config: SchedulerConfig): void {
  // Stop existing scheduler first
  stopScheduler(agentName)

  bgLog.info(`Starting scheduler for "${agentName}": ${JSON.stringify(config)}`)

  if (config.type === "none") {
    // No scheduling needed - agent is triggered manually via WebSocket
    _activeSchedulers.set(agentName, { config, alarmName: "" })
    return
  }

  const alarmName = `lts_scheduler_${agentName}`
  _activeSchedulers.set(agentName, { config, alarmName })

  if (config.type === "interval") {
    const intervalMs = config.value as number
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      bgLog.error(`Invalid interval value for "${agentName}": ${intervalMs}`)
      return
    }

    // Chrome alarms use minutes, minimum is 1 minute
    const intervalMinutes = Math.max(1, Math.ceil(intervalMs / 60000))
    
    chrome.alarms.create(alarmName, {
      delayInMinutes: intervalMinutes,
      periodInMinutes: intervalMinutes
    })

    bgLog.info(`Scheduler: "${agentName}" interval set to ${intervalMinutes} minutes (requested ${intervalMs}ms)`)
  }

  if (config.type === "cron") {
    // For cron, we'll use a 1-minute periodic alarm and check if it matches the cron expression
    const cronExpr = config.value as string
    
    chrome.alarms.create(alarmName, {
      delayInMinutes: 1,
      periodInMinutes: 1
    })

    bgLog.info(`Scheduler: "${agentName}" cron set to "${cronExpr}" (checked every minute)`)
  }
}

/**
 * Stop scheduler for an agent
 */
export function stopScheduler(agentName: string): void {
  const scheduler = _activeSchedulers.get(agentName)
  if (!scheduler) return

  if (scheduler.alarmName) {
    chrome.alarms.clear(scheduler.alarmName)
  }

  _activeSchedulers.delete(agentName)
  bgLog.info(`Scheduler stopped for "${agentName}"`)
}

/**
 * Update scheduler config for an agent
 */
export function updateScheduler(agentName: string, config: SchedulerConfig): void {
  bgLog.info(`Updating scheduler for "${agentName}": ${JSON.stringify(config)}`)
  startScheduler(agentName, config)
}

/**
 * Handle chrome.alarms.onAlarm events
 */
export function handleAlarm(alarm: chrome.alarms.Alarm): void {
  if (!alarm.name.startsWith("lts_scheduler_")) return

  const agentName = alarm.name.replace("lts_scheduler_", "")
  const scheduler = _activeSchedulers.get(agentName)
  
  if (!scheduler) {
    bgLog.warn(`Alarm fired for unknown agent: ${agentName}`)
    chrome.alarms.clear(alarm.name)
    return
  }

  if (scheduler.config.type === "interval") {
    // For interval, always trigger
    bgLog.info(`Scheduler: interval trigger for "${agentName}"`)
    triggerAgent(agentName).catch((e: unknown) => {
      bgLog.error(`Scheduler: interval trigger failed for "${agentName}":`, e instanceof Error ? e.message : String(e))
    })
  }

  if (scheduler.config.type === "cron") {
    // For cron, check if current time matches the expression
    const cronExpr = scheduler.config.value as string
    if (shouldTriggerCron(cronExpr)) {
      bgLog.info(`Scheduler: cron trigger for "${agentName}" (${cronExpr})`)
      triggerAgent(agentName).catch((e: unknown) => {
        bgLog.error(`Scheduler: cron trigger failed for "${agentName}":`, e instanceof Error ? e.message : String(e))
      })
    }
  }
}

/**
 * Simple cron matching - checks if current time matches cron expression
 * Supports basic cron format: minute hour day month dayofweek
 */
function shouldTriggerCron(cronExpr: string): boolean {
  try {
    const parts = cronExpr.trim().split(/\s+/)
    if (parts.length !== 5) {
      bgLog.error(`Invalid cron expression: ${cronExpr} (must have 5 fields)`)
      return false
    }

    const now = new Date()
    const [minute, hour, day, month, dayOfWeek] = parts
    
    return (
      matchesCronField(minute, now.getMinutes(), 0, 59) &&
      matchesCronField(hour, now.getHours(), 0, 23) &&
      matchesCronField(day, now.getDate(), 1, 31) &&
      matchesCronField(month, now.getMonth() + 1, 1, 12) &&
      matchesCronField(dayOfWeek, now.getDay(), 0, 6)
    )
  } catch (e) {
    bgLog.error(`Error parsing cron expression "${cronExpr}":`, e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * Check if a value matches a cron field (supports *, numbers, ranges, lists)
 */
function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true
  
  // Handle comma-separated lists
  for (const part of field.split(",")) {
    if (part.includes("-")) {
      // Range: 1-5
      const [start, end] = part.split("-").map(n => parseInt(n, 10))
      if (value >= start && value <= end) return true
    } else if (part.includes("/")) {
      // Step: */5 or 0-30/5
      const [range, step] = part.split("/")
      const stepNum = parseInt(step, 10)
      if (range === "*") {
        return value % stepNum === 0
      } else {
        const [start, end] = range.split("-").map(n => parseInt(n, 10))
        return value >= start && value <= end && (value - start) % stepNum === 0
      }
    } else {
      // Exact match
      if (parseInt(part, 10) === value) return true
    }
  }
  
  return false
}

/**
 * Get active schedulers (for debugging)
 */
export function getActiveSchedulers(): Map<string, { config: SchedulerConfig; alarmName: string }> {
  return new Map(_activeSchedulers)
}