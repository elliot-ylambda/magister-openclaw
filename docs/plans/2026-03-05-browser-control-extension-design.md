# Remote Browser Control via Chrome Extension — Design

**Date:** 2026-03-05
**Status:** Approved

## Overview

Allow Magister users to install a Chrome extension that lets their AI agent control their real browser. The agent can navigate, click, fill forms, and take screenshots on pages where the user is already authenticated (ad platforms, analytics dashboards, social media, CRMs).

## Architecture

```
Chrome Extension  --WSS-->  Gateway  --WS-->  Agent Machine (Fly.io)
(user's laptop)            (Fly.io)           (existing relay server)
  JWT auth                  proxy +            Playwright connects
                            policy             to local /cdp
                            engine
```

The gateway acts as a WebSocket proxy between the extension and the user's agent machine. The agent machine already runs OpenClaw's extension relay server (port 18792) and Playwright connects to it via `chromium.connectOverCDP()`. No changes needed on the agent side.

## Components

### A. Chrome Extension (magister-openclaw fork)

Fork OpenClaw's existing `assets/chrome-extension/`. Changes:

1. **Rebrand** — "Magister Browser Control", new icons
2. **Connection URL** — `wss://<gateway>/api/browser/relay` instead of `ws://127.0.0.1:18792/extension`
3. **Auth** — Supabase JWT (from connection token) instead of local gateway token
4. **Options page** — Token-based login instead of port/token manual entry

All existing functionality preserved: chrome.debugger attachment, CDP forwarding, tab lifecycle, MV3 persistence, navigation re-attach.

### B. Gateway WebSocket Route

New file: `gateway/app/routes/browser_relay.py`

- WebSocket endpoint at `/api/browser/relay`
- JWT authentication (query param `?token=<jwt>`)
- Machine lookup + wake-if-suspended (same pattern as chat route)
- Opens WebSocket to agent machine relay at `{machine}.internal:18792/extension`
- Bidirectional frame proxying with policy inspection
- Tracks connection state per user (for webapp status display)

### C. Policy Engine (in gateway proxy)

Three policy types enforced in the gateway before forwarding frames:

**1. URL Allowlist**
Inspects `forwardCDPCommand` frames where CDP method is `Page.navigate` or `Target.createTarget`. Checks the URL's domain against the user's configured allowlist. Blocks with error response if not allowed. Domain matching: `google.com` matches `*.google.com`.

**2. Read-Only Mode**
When enabled, blocks all CDP commands that mutate page state:
- `Input.dispatchMouseEvent` (clicks)
- `Input.dispatchKeyEvent` (keystrokes)
- `Input.insertText`
- `Input.dispatchTouchEvent`
- `Runtime.evaluate` (can execute arbitrary JS)
- `DOM.setAttributeValue`, `DOM.setOuterHTML`, `DOM.removeNode`
- `Page.navigate` (navigation is a mutation)
- `Target.createTarget` (opening tabs)

Allows observation commands: `Page.captureScreenshot`, `Accessibility.getFullAXTree`, `DOM.getDocument`, `Target.getTargets`, `Target.getTargetInfo`, `Runtime.enable`, `Page.enable`, etc.

**3. Browser Control Toggle**
Master on/off. When disabled, gateway rejects WebSocket upgrade entirely.

### D. Database

New migration adding columns to `user_machines`:

- `browser_enabled` boolean DEFAULT false
- `browser_allowed_urls` text[] DEFAULT '{}'
- `browser_read_only` boolean DEFAULT false

Keeping it on `user_machines` (not a new table) since it's 1:1 with users and avoids joins.

### E. Webapp — Settings UI

New "Browser Control" card in the settings page:

- **Install link** — button linking to Chrome Web Store listing
- **Connection token** — "Generate Token" button, displays copyable token
- **Connection status** — green/red dot showing if extension is connected
- **Enable/disable toggle** — master switch for browser control
- **Read-only mode toggle** — when on, agent can only observe, not interact
- **URL allowlist** — add/remove domains (tag-style input)

### F. Webapp — Public Extension Page

New route at `/extension`:

- Hero section explaining browser control
- 3-step how-it-works (install, connect via token, agent controls browser)
- Security/privacy section (what data flows where, what policies exist)
- Install CTA button (Chrome Web Store link)
- Link from settings page and possibly from the main marketing site

### G. Webapp API Routes

- `GET /api/browser/policy` — fetch user's browser policy (enabled, read_only, allowed_urls)
- `PUT /api/browser/policy` — update policy
- `POST /api/browser/token` — generate a connection token for the extension
- `GET /api/browser/status` — check if extension is currently connected (queries gateway)

### H. Gateway API Endpoints (HTTP, not WS)

- `GET /api/browser/status` — returns whether a user's extension is connected (webapp polls this)
- `POST /api/browser/token` — validates a connection token and returns a JWT (called by extension)

## Extension Auth Flow

1. User goes to Settings > Browser Control in webapp
2. Clicks "Generate Connection Token" — webapp creates a short-lived token (UUID, stored in `browser_connection_tokens` or a simple cache, linked to user_id, expires in 10 minutes)
3. User copies token, pastes into extension options page
4. Extension sends token to `POST /api/browser/token` on the gateway
5. Gateway validates token, returns a long-lived JWT (or the user's existing Supabase JWT)
6. Extension stores JWT in `chrome.storage.local`, uses for WebSocket auth

## Read-Only Mode Detail

CDP commands are categorized:

**Allowed in read-only mode (observation):**
- Page.captureScreenshot
- Page.enable, Page.disable
- Page.getLayoutMetrics
- Accessibility.enable, Accessibility.getFullAXTree
- DOM.getDocument, DOM.describeNode, DOM.querySelector
- Target.getTargets, Target.getTargetInfo, Target.setAutoAttach, Target.setDiscoverTargets, Target.attachToTarget
- Runtime.enable, Runtime.disable
- Browser.getVersion
- Network.enable, Network.disable

**Blocked in read-only mode (mutation):**
- Input.* (all input events)
- Runtime.evaluate (can execute arbitrary JS)
- Page.navigate, Page.reload
- Target.createTarget, Target.closeTarget
- DOM.setAttributeValue, DOM.setOuterHTML, DOM.removeNode, DOM.setFileInputFiles
- Emulation.setDeviceMetricsOverride
- Page.handleJavaScriptDialog

The gateway sends back an error response for blocked commands: `{"id": <id>, "error": "Blocked: browser is in read-only mode"}`

## What's NOT in MVP

- Runtime.evaluate content inspection (JS expression analysis)
- User confirmation flow for high-risk actions
- Screenshot/data redaction
- Tab count limits
- Admin-level policy overrides
- Per-session domain scoping
- Audit logging (can add later since all frames pass through gateway)

## Security Summary

- TLS (WSS) from extension to gateway
- JWT authentication on every connection
- Per-user machine isolation (extension connects only to own machine)
- URL allowlist prevents navigation to unauthorized sites
- Read-only mode prevents all page mutations
- Master toggle to disable entirely
- No credentials stored in extension beyond JWT
- Gateway is sole communication path — no direct extension-to-machine connection
