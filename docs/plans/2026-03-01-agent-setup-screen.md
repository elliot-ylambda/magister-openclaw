# Agent Setup Screen Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `/checkout/success` with an animated setup screen that polls real provisioning progress and blocks until the machine is running.

**Architecture:** Two-phase polling page. Phase 1 polls `/api/stripe/status` for subscription activation. Phase 2 calls the gateway directly (via `NEXT_PUBLIC_GATEWAY_URL` + Supabase JWT, matching existing codebase pattern) for `provisioning_step` (0→5) and `status`. Steps render as an animated checklist. Auto-redirects to `/chat` when machine is running.

**Tech Stack:** Next.js (React 19), Tailwind CSS v4, Lucide icons, FastAPI (gateway status endpoint)

---

### Task 1: Add `provisioning_step` to gateway status response

**Files:**
- Modify: `gateway/app/routes/status.py:39-48`
- Create: `gateway/tests/test_routes/test_status.py`

**Step 1: Write the failing test**

Create `gateway/tests/test_routes/test_status.py`:

```python
"""Tests for the /api/status route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import MachineStatus, UserMachine
from app.routes.status import create_status_router


def _make_machine(status: MachineStatus = MachineStatus.running, **overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id="user-1",
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=status,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        current_image="registry.fly.io/openclaw:test",
        provisioning_step=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine.return_value = None
    mock.get_monthly_llm_spend.return_value = 0
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.get_machine.return_value = {"id": "mach_123", "state": "started"}
    return mock


def _make_app(mock_fly, mock_supabase):
    app = FastAPI()

    async def fake_verify_jwt():
        return "user-1"

    router = create_status_router(mock_fly, mock_supabase, fake_verify_jwt)
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_status_returns_provisioning_step(mock_fly, mock_supabase):
    """Status response includes provisioning_step during provisioning."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning, provisioning_step=3
    )
    client = _make_app(mock_fly, mock_supabase)
    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["provisioning_step"] == 3


def test_status_provisioning_step_for_running_machine(mock_fly, mock_supabase):
    """Running machine returns provisioning_step=5."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.running, provisioning_step=5
    )
    client = _make_app(mock_fly, mock_supabase)
    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["provisioning_step"] == 5
    assert data["status"] == "running"
```

**Step 2: Run test to verify it fails**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_status.py -v`
Expected: `test_status_returns_provisioning_step` FAILS (KeyError: 'provisioning_step')

**Step 3: Add `provisioning_step` to the status response**

In `gateway/app/routes/status.py`, add `"provisioning_step": machine.provisioning_step,` to the return dict.

**Step 4: Run tests to verify they pass**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_status.py -v`
Expected: Both tests PASS

**Step 5: Commit**

```bash
git add gateway/app/routes/status.py gateway/tests/test_routes/test_status.py
git commit -m "feat(gateway): expose provisioning_step in status response"
```

---

### Task 2: Add `provisioning_step` to webapp `AgentStatus` type

**Files:**
- Modify: `webapp/src/lib/gateway.ts:13-29`

**Step 1: Add `provisioning_step?: number` to the `AgentStatus` type**

In `webapp/src/lib/gateway.ts`, add the field after `llm_spend_cents`:

```typescript
  provisioning_step?: number;
```

**Step 2: Verify build**

Run: `cd webapp && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add webapp/src/lib/gateway.ts
git commit -m "feat(webapp): add provisioning_step to AgentStatus type"
```

---

### Task 3: Rewrite `/checkout/success` page with setup screen

This is the main UI change. The page calls the gateway directly using `NEXT_PUBLIC_GATEWAY_URL` + Supabase client JWT — the same pattern used by `AgentStatusBadge`, `chat-session-client`, and `files-client`.

**Files:**
- Modify: `webapp/src/app/checkout/success/page.tsx` (full rewrite)

**Step 1: Write the new setup screen**

Replace `webapp/src/app/checkout/success/page.tsx` with:

```tsx
'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { getAgentStatus } from '@/lib/gateway';

const SUBSCRIPTION_POLL_MS = 2_000;
const STATUS_POLL_MS = 3_000;
const TIMEOUT_MS = 180_000; // 3 minutes
const REDIRECT_DELAY_MS = 1_500;

const SETUP_STEPS = [
  { step: 0, label: 'Initializing agent' },
  { step: 1, label: 'Creating dedicated environment' },
  { step: 2, label: 'Configuring credentials' },
  { step: 3, label: 'Allocating storage' },
  { step: 4, label: 'Deploying AI agent' },
  { step: 5, label: 'Starting up' },
] as const;

type Phase = 'subscription' | 'provisioning' | 'ready' | 'error';

export default function CheckoutSuccessPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [phase, setPhase] = useState<Phase>('subscription');
  const [provisioningStep, setProvisioningStep] = useState(-1);
  const [errorMessage, setErrorMessage] = useState('');

  // Phase 1: Poll for subscription activation
  useEffect(() => {
    if (phase !== 'subscription') return;

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch('/api/stripe/status');
        const { active } = await res.json();
        if (active) {
          setPhase('provisioning');
          return;
        }
      } catch {
        // Network error — keep polling
      }

      if (Date.now() - start > TIMEOUT_MS) {
        setErrorMessage(
          'Your payment was received but setup is taking longer than expected.'
        );
        setPhase('error');
        return;
      }

      timer = setTimeout(poll, SUBSCRIPTION_POLL_MS);
    }

    poll();
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase 2: Poll gateway for provisioning progress
  useEffect(() => {
    if (phase !== 'provisioning') return;

    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!gatewayUrl) return;

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          timer = setTimeout(poll, STATUS_POLL_MS);
          return;
        }

        const data = await getAgentStatus(gatewayUrl!, session.access_token);

        if (data) {
          if (data.status === 'running') {
            setProvisioningStep(5);
            setPhase('ready');
            return;
          }

          if (data.status === 'failed') {
            setErrorMessage(
              'Something went wrong setting up your agent. Please try again.'
            );
            setPhase('error');
            return;
          }

          if (typeof data.provisioning_step === 'number') {
            setProvisioningStep(data.provisioning_step);
          }
        }
        // null = 404 (no machine record yet, webhook still processing)
      } catch {
        // Network error — keep polling
      }

      if (Date.now() - start > TIMEOUT_MS) {
        setErrorMessage(
          'Agent setup is taking longer than expected. Please try again.'
        );
        setPhase('error');
        return;
      }

      timer = setTimeout(poll, STATUS_POLL_MS);
    }

    poll();
    return () => clearTimeout(timer);
  }, [phase, supabase]);

  // Phase 3: Redirect when ready
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setTimeout(() => router.replace('/chat'), REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, router]);

  const handleRetry = useCallback(async () => {
    setErrorMessage('');
    setPhase('provisioning');
    setProvisioningStep(-1);

    try {
      await fetch('/api/provision/retry', { method: 'POST' });
    } catch {
      // If retry call fails, polling will pick up existing state
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-lg">
        {/* Header */}
        {phase === 'ready' ? (
          <div className="mb-6 flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-green-500" />
            <div>
              <h1 className="text-lg font-semibold">Your agent is ready!</h1>
              <p className="text-sm text-muted-foreground">
                Redirecting you now&hellip;
              </p>
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="mb-6 flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <div>
              <h1 className="text-lg font-semibold">Setup issue</h1>
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <h1 className="text-lg font-semibold">Setting up your agent</h1>
            <p className="text-sm text-muted-foreground">
              {phase === 'subscription'
                ? 'Activating your subscription...'
                : 'This usually takes about a minute.'}
            </p>
          </div>
        )}

        {/* Step list */}
        {phase !== 'subscription' && (
          <div className="space-y-3">
            {SETUP_STEPS.map(({ step, label }) => {
              const isCompleted = phase === 'ready' || provisioningStep > step;
              const isActive =
                phase === 'provisioning' && provisioningStep === step;

              return (
                <div key={step} className="flex items-center gap-3">
                  {isCompleted ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  ) : isActive ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                  )}
                  <span
                    className={
                      isCompleted
                        ? 'text-sm text-muted-foreground'
                        : isActive
                          ? 'text-sm text-foreground'
                          : 'text-sm text-muted-foreground/40'
                    }
                  >
                    {label}
                    {isActive && '...'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Subscription phase spinner */}
        {phase === 'subscription' && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {/* Progress bar */}
        {(phase === 'provisioning' || phase === 'ready') && (
          <div className="mt-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{
                  width: `${phase === 'ready' ? 100 : Math.max(5, ((provisioningStep + 1) / SETUP_STEPS.length) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Error actions */}
        {phase === 'error' && (
          <div className="mt-6 flex gap-3">
            <button
              onClick={handleRetry}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Try again
            </button>
            <button
              onClick={() => router.replace('/chat')}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Continue anyway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `cd webapp && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add webapp/src/app/checkout/success/page.tsx
git commit -m "feat(webapp): replace checkout success with agent setup screen"
```

---

### Task 4: Add `/api/provision/retry` route in webapp

The retry button needs to re-trigger provisioning. This calls the gateway's provision endpoint using `GATEWAY_API_KEY` (server-only secret, same pattern as the billing webhook).

**Files:**
- Create: `webapp/src/app/api/provision/retry/route.ts`

**Step 1: Create the retry route**

```typescript
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const GATEWAY_URL = process.env.GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('plan')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  const plan = subscription?.plan ?? 'cmo';

  const res = await fetch(`${GATEWAY_URL}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id: user.id, plan }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
```

**Step 2: Verify build**

Run: `cd webapp && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add webapp/src/app/api/provision/retry/route.ts
git commit -m "feat(webapp): add /api/provision/retry route for setup screen error recovery"
```

---

### Task 5: Run full test suite and verify

**Step 1: Run gateway tests**

Run: `make gateway-test`
Expected: All tests pass

**Step 2: Run webapp build**

Run: `make webapp-build`
Expected: Build succeeds with no errors

**Step 3: Final commit (if any lint fixes needed)**

```bash
git add -A
git commit -m "chore: lint fixes for agent setup screen feature"
```
