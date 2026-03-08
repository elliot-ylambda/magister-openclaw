# Chrome Extension Standalone Copy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the Chrome extension from the `magister-openclaw` submodule into a standalone `extension/` directory at the repo root, with Magister-branded icons and options page redesigned to match the webapp's dark settings UI.

**Architecture:** Copy the 6 extension source files into `extension/`, replace icons with Magister logo PNGs (already generated in `extension/icons/`), completely redesign `options.html` to match the Magister webapp dark theme (pure black background, `#0a0a0a` cards, `rgba(255,255,255,0.1)` borders, system-ui font stack). JS files are copied verbatim — no logic changes. The extension is a pure WebSocket client; the relay server inside OpenClaw is unaffected.

**Tech Stack:** Chrome Extension MV3, vanilla JS (ES modules), HTML/CSS (no build step)

**What NOT to change (critical for relay compatibility):**
- `background-utils.js` — `deriveRelayToken()` HMAC must match relay server exactly
- `background.js` — WebSocket protocol, CDP forwarding, storage keys (`gatewayJwt`, `gatewayUrl`, `relayPort`, `gatewayToken`)
- `options.js` — token exchange flow, storage key names, DOM element IDs (JS references them)
- `options-validation.js` — validation logic unchanged
- `manifest.json` — permissions, host_permissions, service_worker config

---

### Task 1: Copy JS files verbatim from submodule

**Files:**
- Create: `extension/background.js` (copy from `magister-openclaw/assets/chrome-extension/background.js`)
- Create: `extension/background-utils.js` (copy from `magister-openclaw/assets/chrome-extension/background-utils.js`)
- Create: `extension/options.js` (copy from `magister-openclaw/assets/chrome-extension/options.js`)
- Create: `extension/options-validation.js` (copy from `magister-openclaw/assets/chrome-extension/options-validation.js`)

**Step 1: Copy files**

```bash
cp magister-openclaw/assets/chrome-extension/background.js extension/background.js
cp magister-openclaw/assets/chrome-extension/background-utils.js extension/background-utils.js
cp magister-openclaw/assets/chrome-extension/options.js extension/options.js
cp magister-openclaw/assets/chrome-extension/options-validation.js extension/options-validation.js
```

**Step 2: Verify files match source exactly**

```bash
diff magister-openclaw/assets/chrome-extension/background.js extension/background.js
diff magister-openclaw/assets/chrome-extension/background-utils.js extension/background-utils.js
diff magister-openclaw/assets/chrome-extension/options.js extension/options.js
diff magister-openclaw/assets/chrome-extension/options-validation.js extension/options-validation.js
```

Expected: No output (files identical).

**Step 3: Commit**

```bash
git add extension/background.js extension/background-utils.js extension/options.js extension/options-validation.js
git commit -m "feat: copy extension JS files from openclaw submodule"
```

---

### Task 2: Write manifest.json (identical logic, uses new icons)

**Files:**
- Create: `extension/manifest.json`

**Step 1: Write manifest**

The manifest is identical to the submodule version. Icons already exist at `extension/icons/` (generated earlier with Magister branding).

Verify icons exist:
```bash
ls -la extension/icons/
```

Expected: `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`

**Step 2: Commit icons + manifest**

```bash
git add extension/manifest.json extension/icons/
git commit -m "feat: add Magister-branded manifest and icons"
```

Note: `extension/manifest.json` was already created in a prior session. Verify it matches the submodule's permissions/config exactly (only icons and metadata should differ from source — but currently they're identical).

---

### Task 3: Redesign options.html — Magister dark theme

**Files:**
- Create: `extension/options.html`

This is the major creative task. The new options page must:

1. **Match the Magister webapp dark theme exactly:**
   - Background: `#000000` (pure black)
   - Card background: `#0a0a0a`
   - Borders: `rgba(255, 255, 255, 0.1)`
   - Text: `#fafafa` (foreground), `#6b7280` (muted)
   - Inputs: `rgba(255, 255, 255, 0.1)` border, `#0a0a0a` background
   - Buttons primary: `#ffffff` bg, `#000000` text
   - Buttons outline: transparent bg, `rgba(255, 255, 255, 0.1)` border
   - Border radius: `10px` (cards), `6px` (inputs/buttons)
   - Font: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
   - Monospace: `ui-monospace, Menlo, Monaco, Consolas, monospace`
   - Max width: `672px` (matches webapp `max-w-2xl`)

2. **Use the Magister logo SVG inline** (not the PNG icon) in the header — white logo on black, matching the webapp nav.

3. **Keep all DOM element IDs identical** — `options.js` references these by ID:
   - `connection-token`, `connect-btn`, `disconnect-btn`
   - `gateway-status`, `connect-section`, `connected-section`, `gateway-connect-status`
   - `port`, `token`, `save`, `relay-url`, `status`

4. **Layout structure:**
   - Header: Magister logo SVG + "Magister Browser Control" title + subtitle
   - Section 1 (card): "Connect to Magister" — token input, connect/disconnect, status badge
   - Section 2 (card, collapsible): "Advanced: Local Mode" — port, gateway token, save
   - All sections use `rounded-xl border` card style matching `browser-control.tsx`

5. **Status badges:** Match the webapp badge pattern:
   - Connected: emerald dot + "Connected to Magister" on `rgba(16,185,129,0.1)` bg
   - Disconnected: gray dot + "Not connected" on `rgba(255,255,255,0.05)` bg

6. **Status messages:** Match the webapp alert pattern:
   - Success: `rgba(16,185,129,0.1)` bg, `#10b981` text
   - Error: `rgba(239,68,68,0.1)` bg, `#ef4444` text

**Step 1: Write the complete options.html**

See implementation below. All CSS is inline (no external dependencies — extension must work offline).

**Step 2: Verify element IDs match options.js expectations**

Manually check that all IDs referenced in `options.js` exist in the new HTML:
- `connection-token` ✓
- `connect-btn` ✓
- `disconnect-btn` ✓
- `gateway-status` ✓
- `connect-section` ✓
- `connected-section` ✓
- `gateway-connect-status` ✓
- `port` ✓
- `token` ✓
- `save` ✓
- `relay-url` ✓
- `status` ✓

**Step 3: Load in Chrome as unpacked extension and verify:**
- Page renders with dark theme
- "Connect to Magister" card visible
- "Advanced: Local Mode" collapses/expands
- Token input and buttons are interactive

**Step 4: Commit**

```bash
git add extension/options.html
git commit -m "feat: redesign extension options page with Magister dark theme"
```

---

### Task 4: Verify full extension loads in Chrome

**Step 1: Load unpacked extension**

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/` directory
4. Verify no errors in the extension card

**Step 2: Functional checks**

- Click extension icon → should show "connecting" badge then error (no relay running)
- Right-click extension → "Options" → should open redesigned settings page
- Options page: paste a fake token, click Connect → should show "Connection failed" error (expected — no gateway)
- Options page: expand "Advanced: Local Mode" → port field shows 18792

**Step 3: Visual checks**

- Options page background is pure black
- Cards have `#0a0a0a` background with subtle borders
- Magister logo SVG renders in the header
- Typography matches webapp settings style
- Badge colors match (emerald for connected, gray for disconnected)

---

### Task 5: Final commit — complete extension directory

**Step 1: Verify directory structure**

```bash
ls -la extension/
```

Expected:
```
extension/
├── manifest.json
├── background.js
├── background-utils.js
├── options.html
├── options.js
├── options-validation.js
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

**Step 2: Verify nothing in the gateway or openclaw-image was changed**

```bash
git diff -- gateway/ openclaw-image/
```

Expected: Only the pre-existing unstaged changes (relay ports, entrypoint, Dockerfile).

**Step 3: Final commit if any remaining files**

```bash
git status
```

If all extension files are already committed from Tasks 1-4, done. Otherwise commit remaining.

---

## What This Does NOT Change

- **Gateway relay proxy** (`gateway/app/routes/browser_relay.py`) — unchanged, still connects to relay on agent machine
- **OpenClaw relay server** (`magister-openclaw/src/browser/extension-relay.ts`) — unchanged, runs inside agent machine
- **Token derivation** — `deriveRelayToken()` in both extension and gateway use identical HMAC-SHA256
- **WebSocket protocol** — all message formats (`forwardCDPCommand`, `forwardCDPEvent`, `connect.challenge`) unchanged
- **Chrome storage keys** — `gatewayJwt`, `gatewayUrl`, `relayPort`, `gatewayToken` unchanged
- **Webapp browser settings UI** — `browser-control.tsx` and API routes unchanged
- **Database schema** — no migration changes

## Risk Assessment

**Risk: None** — The extension is a pure client. It connects to the gateway WebSocket (`/api/browser/relay`) or local relay (`ws://127.0.0.1:18792/extension`). The relay server doesn't know or care where the extension source files live. As long as:
1. `deriveRelayToken()` produces identical HMAC output → ✅ copied verbatim
2. WebSocket message format is unchanged → ✅ `background.js` copied verbatim
3. Storage keys match what `options.js` writes → ✅ `options.js` copied verbatim
4. DOM element IDs in `options.html` match what `options.js` reads → ✅ explicitly verified

The only change is visual (icons + options.html CSS/layout). All JS logic is byte-for-byte identical.
