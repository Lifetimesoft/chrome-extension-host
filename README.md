# Lifetimesoft Chrome Extension Host

Chrome Extension Host for running multiple AI Agents built with `@lifetimesoft/agent-sdk`.

This extension acts as a **Host Application** for browser-based agents, similar to how Steam runs multiple games or how Docker Desktop runs multiple containers.

---

## Overview

The Lifetimesoft Chrome Extension Host allows users to:

* Login to Lifetimesoft SaaS
* Browse and install agents from the marketplace
* Configure agent environment variables
* Start and stop agents
* View logs
* Run multiple agents in a single extension
* Schedule agents using Chrome Alarms
* Access browser APIs such as tabs, cookies, and DOM

---

## Architecture

```text
Lifetimesoft SaaS
    ↓
Marketplace / Registry
    ↓
Chrome Extension Host
    ↓
@lifetimesoft/agent-sdk
    ↓
Installed Agents
```

---

## Key Concepts

### Host Application

This Chrome extension is a Host Application responsible for:

* Authentication
* Downloading agents
* Running agents
* Scheduling
* Logging
* Monitoring
* Configuration UI

### Agent

An Agent is a package built with `@lifetimesoft/agent-sdk` containing business logic.

### Runtime

The extension provides a Chrome-specific runtime using:

* Background Service Worker
* `chrome.storage`
* `chrome.alarms`
* `chrome.tabs`
* `chrome.cookies`
* `chrome.scripting`

---

## One Extension, Multiple Agents

This extension supports multiple installed agents.

```text
Chrome Extension Host
├── pt-commenter
├── short-video-generator
├── web-summarizer
└── custom-agent
```

---

## Installation Model

### Install Extension Once

Users install the extension from the Chrome Web Store.

### Install Agents from Marketplace

Users can install and uninstall agents from the Lifetimesoft Marketplace without reinstalling the extension.

---

## Agent Lifecycle

### Install Agent

1. Download agent bundle from registry
2. Store bundle in `chrome.storage.local`
3. Save metadata and configuration

### Start Agent

1. Load agent bundle
2. Create execution context (`ctx`)
3. Schedule with `chrome.alarms`
4. Run `agent.run(ctx)`

### Stop Agent

1. Remove alarms
2. Update status to `stopped`

### Uninstall Agent

1. Stop agent
2. Remove stored files and configuration

---

## Scheduling

The extension supports the same scheduler configuration as the Node runtime.

```json
{ "type": "none" }
{ "type": "interval", "value": 600000 }
{ "type": "cron", "value": "*/10 * * * *" }
```

Implemented using `chrome.alarms`.

---

## User Interface

### Popup

Quick access panel used for:

* Open Dashboard
* Login / Logout
* View running agent count

### Dashboard

Main management interface opened in a new tab.

Sections:

* Marketplace
* Installed Agents
* Agent Details
* Logs
* Settings

### Agent Detail Page

Each agent has its own detail page for:

* Start / Stop
* Update
* Uninstall
* Configure environment variables
* View logs

---

## Data Model

### Installed Agent

```json
{
  "name": "pt-commenter",
  "version": "0.0.1",
  "status": "running",
  "config": {},
  "installed_at": 1710000000
}
```

---

## Phase 1 Limitation

Each installed agent can run only one instance.

```text
1 Installed Agent = 1 Running Instance
```

Multi-instance support may be added in a future version.

---

## Browser Capabilities

Agents can request browser features in `agent.json`.

```json
{
  "capabilities": {
    "browser": {
      "features": ["tabs", "cookies", "dom", "scripting"]
    }
  }
}
```

These capabilities are exposed through `ctx.browser`.

---

## Authentication

The extension authenticates with Lifetimesoft SaaS and stores access tokens securely in `chrome.storage.local`.

The host is responsible for:

* Login
* Logout
* Token refresh
* API requests

Agents never handle SaaS authentication directly.

---

## Logging

All logs produced by `ctx.log` are stored locally and displayed in the dashboard.

Example:

```ts
ctx.log.info("Agent started");
ctx.log.error("Something went wrong");
```

---

## Monitoring

The host may send:

* Heartbeats
* Status updates
* Optional logs

to Lifetimesoft SaaS for monitoring.

---

## Supported Runtime APIs

Available to agents through `ctx`:

* `ctx.ai`
* `ctx.storage`
* `ctx.queue`
* `ctx.log`
* `ctx.meta`
* `ctx.browser`

---

## Development

### Install Dependencies

```bash
npm install
```

### Run Development Build

```bash
npm run dev
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
├── public/
├── src/
│   ├── background/
│   ├── popup/
│   ├── dashboard/
│   ├── runtime/
│   ├── services/
│   ├── storage/
│   └── components/
├── manifest.json
└── package.json
```

---

## Relationship to Other Projects

### `@lifetimesoft/agent-sdk`

Provides:

* `defineAgent()`
* `Context`
* Runtime abstractions

### `@lifetimesoft/lifectl`

CLI Host Application for Node.js agents.

### Chrome Extension Host

GUI Host Application for browser-based agents.

---

## Future Host Applications

The same architecture can be used for:

* Windows Host
* macOS Host
* Mobile Host
* Edge / IoT Host

---

## Analogy

### Steam

* Steam Client = Host Application
* Game = Agent
* Steam Store = Marketplace

### Docker

* Docker Desktop = Host Application
* Container Image = Agent
* Docker Hub = Registry

---

## Vision

Write Agent Once, Run Anywhere.

Agents built with `@lifetimesoft/agent-sdk` can run on:

* Node.js
* Chrome Extension
* Windows Desktop
* Mobile Apps
* Future runtimes

---

## License

MIT
