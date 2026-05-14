# Lifetimesoft Chrome Extension Host

Chrome Extension Host for running multiple AI Agents built with `@lifetimesoft/agent-sdk`.

This extension acts as a **Host Application** for browser-based agents, similar to how Steam runs multiple games or how Docker Desktop runs multiple containers.

---

## Overview

The Lifetimesoft Chrome Extension Host allows users to:

* Login to Lifetimesoft SaaS
* Install agents from the registry via the dashboard
* Start and stop agents
* View logs
* Run multiple agents in a single extension
* Schedule agents using Chrome Alarms

---

## Architecture

```text
Lifetimesoft SaaS (app-ai)
    ↓  /agents/info  (compatibility check)
    ↓  /agents/pull  (download bundle)
Chrome Extension Host
    ├── Background Service Worker
    ├── Offscreen Document  ←→  Sandbox iframe
    └── @lifetimesoft/agent-sdk (agent code)
```

### Sandbox Execution

Agent code runs inside a **sandboxed iframe** via an Offscreen Document. This satisfies MV3's restriction on dynamic code evaluation while keeping agents isolated from the extension's own context.

```text
Background SW
    → chrome.runtime.sendMessage("offscreen_run")
    → Offscreen Document
        → postMessage to sandbox iframe
            → new Function(agentCode)(ctx)
    ← postMessage back (log / done / error)
    ← chrome.runtime.sendMessage back to background
```

The context proxy (`ctx`) relays `ctx.storage`, `ctx.ai`, and `ctx.log` calls back to the background service worker via `postMessage`, so agents never touch `chrome.*` APIs directly.

---

## Capabilities & Compatibility

Before installing an agent, the host calls `/agents/info?host=chrome` to verify the agent is compatible with the Chrome runtime.

The server checks the agent's declared `capabilities` against the Chrome host's supported feature set:

| Category | Chrome Host |
|---|---|
| `ai.chat` | ✅ |
| `ai.image` | ✅ |
| `ai.video` | ✅ |
| `system.fs` | ❌ |
| `system.browser-automation` | ❌ |

If the agent requires capabilities the Chrome host does not support (e.g. `system.fs`), installation is rejected with a clear error message.

---

## Key Concepts

### Host Application

This Chrome extension is a Host Application responsible for:

* Authentication
* Downloading and caching agent bundles
* Running agents inside a sandbox
* Scheduling via `chrome.alarms`
* Logging
* Configuration UI

### Agent

An Agent is a package built with `@lifetimesoft/agent-sdk` containing portable business logic. The agent code itself has no dependency on Chrome APIs.

### Sandbox

Agent code is executed inside a sandboxed iframe using `new Function(code)`. The sandbox communicates with the host only through `postMessage`.

---

## One Extension, Multiple Agents

```text
Chrome Extension Host
├── hello-world-agent
├── web-summarizer
└── custom-agent
```

---

## Agent Lifecycle

### Install Agent

1. Call `/agents/info?host=chrome` — verify agent exists and is compatible
2. Save metadata to `chrome.storage.local`
3. Agent starts in `stopped` state

### Start Agent

1. Fetch agent bundle from `/agents/pull` (cached in memory)
2. Decompress `.tar.gz` → extract `dist/index.js`
3. Send code to offscreen document → sandbox iframe
4. Sandbox executes `agent.run(ctx)`
5. Schedule next run via `chrome.alarms`

### Stop Agent

1. Remove alarms
2. Send stop signal to sandbox
3. Update status to `stopped`

### Uninstall Agent

1. Stop agent if running
2. Remove metadata from storage
3. Clear bundle cache

---

## Scheduling

```json
{ "type": "none" }
{ "type": "interval", "value": 600000 }
{ "type": "cron", "value": "*/10 * * * *" }
```

Implemented using `chrome.alarms`.

---

## User Interface

### Popup

Quick access panel:

* Login / Logout
* Running agent count
* Open Dashboard button

### Dashboard

Full management interface (opens in a new tab):

* Install agents by name + version
* Start / Stop / Uninstall agents
* View agent status badges
* Settings (disconnect all, reconnect all, sign out)

---

## Data Model

### Installed Agent

```json
{
  "name": "hello-world-agent",
  "version": "0.0.1",
  "status": "running",
  "config": {},
  "installed_at": 1710000000
}
```

---

## Supported Runtime APIs

Available to agents through `ctx`:

| API | Description |
|---|---|
| `ctx.ai` | AI chat / image / video (proxied via background) |
| `ctx.storage` | Key-value storage (proxied via background) |
| `ctx.log` | Structured logging |
| `ctx.meta` | Agent metadata and run info |
| `ctx.config` | Agent environment config |

---

## Development

### Install Dependencies

```bash
npm install
```

### Build Extension

```bash
npm run build
```

### Load Unpacked Extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `dist` directory

---

## Repository Structure

```text
chrome-extension-host/
├── src/
│   ├── background/       ← Service worker entry point
│   ├── popup/            ← Popup UI
│   ├── dashboard/        ← Dashboard UI (full tab)
│   ├── offscreen/        ← Offscreen document (sandbox bridge)
│   ├── sandbox/          ← Sandboxed iframe (agent execution)
│   ├── logs/             ← Log viewer UI
│   ├── services/
│   │   ├── agent.service.ts    ← Install / uninstall / list
│   │   ├── auth.service.ts     ← Login / logout / token refresh
│   │   ├── runtime.service.ts  ← Start / stop agent runtime
│   │   └── sandbox.service.ts  ← Bundle fetch + sandbox execution
│   ├── storage/          ← chrome.storage wrappers
│   └── utils/            ← Logger, helpers
├── manifest.json
└── package.json
```

---

## Relationship to Other Projects

| Project | Role |
|---|---|
| `@lifetimesoft/agent-sdk` | Provides `defineAgent()`, `Context`, runtime abstractions |
| `lifectl` | Node.js CLI Host — runs agents on the server |
| `app-ai` | Backend registry — push/pull/info/run APIs |
| `chrome-extension-host` | This project — Chrome GUI Host |

---

## Vision

Write Agent Once, Run Anywhere.

Agents built with `@lifetimesoft/agent-sdk` can run on:

* Node.js (lifectl)
* Chrome Extension (this project)
* Future: Mobile, Desktop, Edge

---

## License

MIT
