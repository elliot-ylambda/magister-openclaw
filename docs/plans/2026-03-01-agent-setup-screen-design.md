# Agent Setup Screen Design

**Date:** 2026-03-01
**Status:** Approved

## Overview

Replace the `/checkout/success` page with a full agent setup experience that shows real provisioning progress. After Stripe checkout, users see an animated step-by-step screen that polls the gateway for actual `provisioning_step` progress and auto-redirects to `/chat` once the machine is running.

## Flow

```
Stripe Checkout → /checkout/success (setup screen)
  Phase 1: Poll /api/stripe/status until subscription active (~2-5s)
  Phase 2: Poll /api/status every 3s for provisioning_step (0→5)
  Phase 3: "Your agent is ready!" → auto-redirect to /chat after 1.5s
```

## Changes

### Gateway (`gateway/app/routes/status.py`)
- Add `provisioning_step` to the status response JSON

### Webapp (`webapp/src/lib/gateway.ts`)
- Add `provisioning_step?: number` to the `AgentStatus` type

### Webapp (`webapp/src/app/checkout/success/page.tsx`)
- Rewrite: two-phase polling (subscription → provisioning) with animated step checklist

## Step Mapping

| `provisioning_step` | Label |
|---|---|
| 0 | Initializing agent... |
| 1 | Creating dedicated environment... |
| 2 | Configuring credentials... |
| 3 | Allocating storage... |
| 4 | Deploying AI agent... |
| 5 (+ status=running) | Starting up... |

## UI

Minimal centered card. Completed steps show green check, active step shows spinner, pending steps show gray circle. Progress bar at bottom. On completion: title changes to "Your agent is ready!", all checks green, 1.5s pause then redirect.

## Error Handling

- `status === 'failed'`: Error message + retry button (re-calls /api/provision)
- Timeout (>3 min): Same error UI with retry
- Page refresh: Idempotent — re-polls current state
- Machine already running: Skip to ready → redirect
- No machine record yet: Stay in subscription phase, transition when record appears
