# OAuth Integrations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/connections` page where users can OAuth to third-party services (starting with GitHub), with tokens injected as Fly secrets and MCP servers activated on machine restart.

**Architecture:** Users OAuth via the webapp, tokens are stored in a generic `integrations` table in Supabase, then injected as Fly secrets on the user's machine (which triggers a Fly redeploy). The `entrypoint.sh` is refactored to run OpenClaw under a supervisor wrapper so it can be restarted independently in the future (via SIGUSR1). On each start, the entrypoint conditionally configures MCP servers based on which env vars are present.

**Tech Stack:** Next.js (webapp), FastAPI (gateway), Supabase (DB), Fly.io (machines), OpenClaw + Claude CLI MCP servers

**Note on restarts:** `fly.set_secrets()` triggers a Fly deployment that restarts the whole machine. So for the OAuth connection flow, the machine restarts anyway. The supervisor pattern enables OpenClaw-only restarts for other scenarios (manual restart, config changes, future token broker migration) without a full machine reboot.

---

## Task 1: Supabase Migration — `integrations` Table

**Files:**
- Create: `webapp/supabase/migrations/20260304000000_create_integrations.sql`

**Step 1: Write the migration**

```sql
-- Generic OAuth integrations table (one row per user-service pair)
CREATE TABLE public.integrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    service         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    access_token    TEXT NOT NULL,
    refresh_token   TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes          TEXT NOT NULL DEFAULT '',
    external_id     TEXT NOT NULL DEFAULT '',
    display_name    TEXT NOT NULL DEFAULT '',
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_user_service UNIQUE (user_id, service),
    CONSTRAINT valid_service CHECK (service IN ('github', 'google_drive', 'webflow')),
    CONSTRAINT valid_status CHECK (status IN ('active', 'revoked', 'error'))
);

-- Fast lookup by user
CREATE INDEX idx_integrations_user ON public.integrations (user_id);

-- Fast lookup by user + service (active only)
CREATE INDEX idx_integrations_user_service ON public.integrations (user_id, service) WHERE status = 'active';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_integrations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_integrations_updated_at
    BEFORE UPDATE ON public.integrations
    FOR EACH ROW EXECUTE FUNCTION update_integrations_updated_at();

-- RLS: users can read their own integrations; writes happen via service_role
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own integrations"
    ON public.integrations
    FOR SELECT
    USING (auth.uid() = user_id);
```

**Step 2: Apply the migration locally**

Run: `make supabase-migrate`
Expected: Migration applies without errors.

**Step 3: Commit**

```bash
git add webapp/supabase/migrations/20260304000000_create_integrations.sql
git commit -m "feat: add integrations table for OAuth connections"
```

---

## Task 2: Gateway — Integration Secrets Route

Generic route for injecting/removing Fly secrets for any integration service. Follows the same pattern as `slack_oauth.py` (request models defined inline, API key auth, factory function).

**Files:**
- Create: `gateway/app/routes/integration_oauth.py`
- Modify: `gateway/app/main.py` (register the new route)

**Step 1: Create the route module**

Create `gateway/app/routes/integration_oauth.py`:

```python
"""Generic integration OAuth helper routes — inject/remove secrets for service integrations.

Called by the webapp after OAuth completes (inject) or on disconnect (remove).
Uses verify_api_key auth (same as provision/destroy).

Note: set_secrets/unset_secrets trigger a Fly deployment that restarts the machine,
so OpenClaw picks up the new MCP config automatically on restart.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.integration_oauth")

# Maps service name -> list of Fly secret key names to set/unset
SERVICE_SECRET_KEYS: dict[str, list[str]] = {
    "github": ["GITHUB_TOKEN"],
    "google_drive": ["GOOGLE_DRIVE_TOKEN", "GOOGLE_DRIVE_REFRESH_TOKEN"],
    "webflow": ["WEBFLOW_TOKEN"],
}


class InjectSecretsRequest(BaseModel):
    user_id: str
    service: str
    secrets: dict[str, str]


class RemoveSecretsRequest(BaseModel):
    user_id: str
    service: str


def create_integration_oauth_router(
    fly: FlyClient,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    async def _get_machine(user_id: str):
        """Look up user's machine; raise if not found or destroyed."""
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")
        if machine.status in (MachineStatus.destroyed, MachineStatus.destroying):
            raise HTTPException(status_code=410, detail="Machine destroyed")
        return machine

    async def _ensure_machine_running(machine, user_id: str):
        """Start the machine if suspended/stopped (secrets require a running machine)."""
        if machine.fly_machine_id and machine.status in (
            MachineStatus.suspended, MachineStatus.stopped,
        ):
            try:
                await fly.start_machine(machine.fly_app_name, machine.fly_machine_id)
                await fly.wait_for_state(
                    machine.fly_app_name, machine.fly_machine_id, "started", timeout_s=60,
                )
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
            except Exception:
                logger.exception(f"[integration] failed to start machine for {user_id}")

    @router.post("/integrations/inject-secrets")
    async def inject_secrets(req: InjectSecretsRequest):
        """Set integration secrets as Fly secrets on user's machine.

        Note: set_secrets triggers a Fly deployment that restarts the machine,
        so the entrypoint re-runs and picks up the new env vars for MCP config.
        """
        if req.service not in SERVICE_SECRET_KEYS:
            raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

        machine = await _get_machine(req.user_id)
        await _ensure_machine_running(machine, req.user_id)

        await fly.set_secrets(machine.fly_app_name, req.secrets)
        logger.info(f"[integration] injected {req.service} secrets for user {req.user_id}")

        return {"status": "secrets_injected"}

    @router.post("/integrations/remove-secrets")
    async def remove_secrets(req: RemoveSecretsRequest):
        """Unset integration secrets from user's Fly machine."""
        if req.service not in SERVICE_SECRET_KEYS:
            raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

        machine = await _get_machine(req.user_id)

        keys = SERVICE_SECRET_KEYS[req.service]
        try:
            await fly.unset_secrets(machine.fly_app_name, keys)
            logger.info(f"[integration] removed {req.service} secrets for user {req.user_id}")
        except Exception:
            logger.exception(f"[integration] failed to remove secrets for {req.user_id}")

        return {"status": "secrets_removed"}

    return router
```

**Step 2: Register the route in `gateway/app/main.py`**

Add the import at the top with the other route imports:

```python
from app.routes.integration_oauth import create_integration_oauth_router
```

Add the router registration after the `slack_oauth` block (around line 116):

```python
    app.include_router(
        create_integration_oauth_router(fly, supabase),
        prefix="/api",
        dependencies=[verify_api_key],
    )
```

**Step 3: Commit**

```bash
git add gateway/app/routes/integration_oauth.py gateway/app/main.py
git commit -m "feat: add generic integration secrets route"
```

---

## Task 3: OpenClaw Image — Supervisor + MCP Config Generation

Currently `entrypoint.sh` runs OpenClaw as PID 1 via `exec`. We refactor it to:
1. Run OpenClaw as a child process under a supervisor loop
2. Listen for SIGUSR1 to restart just OpenClaw (re-generates config first)
3. Conditionally configure MCP servers based on which integration env vars are present

**Files:**
- Modify: `openclaw-image/entrypoint.sh`

**Step 1: Rewrite entrypoint.sh**

```bash
#!/bin/bash
# Initializes OpenClaw home directory, injects LLM proxy credentials,
# configures MCP servers, and runs OpenClaw under a supervisor that
# supports graceful restart via SIGUSR1.
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"

# ── Config Generation Function ────────────────────────────────
# Called on first boot AND on every restart (to pick up new secrets)
generate_config() {
    # First boot: initialize from defaults
    if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
        echo "[entrypoint] First boot — initializing $OPENCLAW_HOME"
        mkdir -p "$OPENCLAW_HOME/credentials"
        mkdir -p "$OPENCLAW_HOME/workspace"
        mkdir -p "$OPENCLAW_HOME/agents"
        cp -r /app/default-config/* "$OPENCLAW_HOME/"
    fi

    # Revert bind to "lan" and ensure OpenResponses endpoint is enabled
    node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
let changed = false;
if (c.gateway && c.gateway.bind !== 'lan') {
  c.gateway.bind = 'lan';
  changed = true;
}
if (!c.gateway) c.gateway = {};
if (!c.gateway.http) c.gateway.http = {};
if (!c.gateway.http.endpoints) c.gateway.http.endpoints = {};
if (!c.gateway.http.endpoints.responses || !c.gateway.http.endpoints.responses.enabled) {
  c.gateway.http.endpoints.responses = { enabled: true };
  changed = true;
}
if (changed) fs.writeFileSync(p, JSON.stringify(c, null, 2));
"

    # Copy/update marketing skills on every boot
    if [ -d "/app/skills" ]; then
        mkdir -p "$OPENCLAW_HOME/skills"
        cp -r /app/skills/* "$OPENCLAW_HOME/skills/"
    fi

    # Purge cached models.json
    find "$OPENCLAW_HOME/agents" -name models.json -delete 2>/dev/null

    # ── LLM Credentials ──────────────────────────────────────────
    if [ -n "$BYOK_ANTHROPIC_KEY" ]; then
        export ANTHROPIC_API_KEY="${BYOK_ANTHROPIC_KEY}"
        echo "[entrypoint] BYOK mode — using user-provided Anthropic API key"
    elif [ -n "$GATEWAY_TOKEN" ]; then
        export OPENROUTER_API_KEY="${GATEWAY_TOKEN}"
        DEFAULT_MODEL="${DEFAULT_MODEL:-anthropic/claude-sonnet-4-6}"
        node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!c.models) c.models = {};
if (!c.models.providers) c.models.providers = {};
delete c.models.providers.anthropic;
c.models.providers.openrouter = {
  baseUrl: '${LLM_BASE_URL:-http://magister-gateway.internal:8081/llm/v1}',
  api: 'openai-completions',
  apiKey: 'OPENROUTER_API_KEY',
  models: [
    { id: '${DEFAULT_MODEL}', name: 'Default', reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 }
  ]
};
if (!c.agents) c.agents = {};
if (!c.agents.defaults) c.agents.defaults = {};
c.agents.defaults.model = { primary: 'openrouter/${DEFAULT_MODEL}' };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
        echo "[entrypoint] Proxy mode — LLM calls route through gateway (openrouter)"
    fi

    # ── Slack Channel ─────────────────────────────────────────────
    if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_SIGNING_SECRET" ]; then
        node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!c.channels) c.channels = {};
c.channels.slack = {
  enabled: true,
  mode: 'http',
  botToken: process.env.SLACK_BOT_TOKEN,
  appToken: 'xapp-http-mode-placeholder',
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  webhookPath: '/slack/events',
  dmPolicy: 'open',
  allowFrom: ['*'],
  groupPolicy: 'open',
  requireMention: true
};
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
        echo "[entrypoint] Slack channel enabled"
    else
        node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (c.channels) delete c.channels.slack;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
        echo "[entrypoint] Slack channel disabled (no credentials)"
    fi

    # ── MCP Servers ───────────────────────────────────────────────
    # Generate MCP config based on which integration tokens are present.
    node -e "
const fs = require('fs');
const mcpConfig = { mcpServers: {} };

if (process.env.GITHUB_TOKEN) {
  mcpConfig.mcpServers.github = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN }
  };
}

// Future: add more services here
// if (process.env.GOOGLE_DRIVE_TOKEN) { ... }
// if (process.env.WEBFLOW_TOKEN) { ... }

const mcpPath = '${OPENCLAW_HOME}/mcp-config.json';
fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));

const serverCount = Object.keys(mcpConfig.mcpServers).length;
console.log('[entrypoint] MCP config: ' + serverCount + ' server(s) configured');
"

    # ── Inject --mcp-config into Claude CLI backend ───────────────
    node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
const mcpPath = '${OPENCLAW_HOME}/mcp-config.json';
const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

// Only add --mcp-config if there are servers configured
if (Object.keys(mcpConfig.mcpServers).length > 0) {
  if (!c.agents) c.agents = {};
  if (!c.agents.defaults) c.agents.defaults = {};
  if (!c.agents.defaults.cliBackends) c.agents.defaults.cliBackends = {};
  if (!c.agents.defaults.cliBackends['claude-cli']) {
    c.agents.defaults.cliBackends['claude-cli'] = {
      command: 'claude',
      args: ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions']
    };
  }
  const args = c.agents.defaults.cliBackends['claude-cli'].args;
  // Remove old --mcp-config flags
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config') { i++; continue; }
    if (args[i] === '--strict-mcp-config') continue;
    filtered.push(args[i]);
  }
  filtered.push('--strict-mcp-config', '--mcp-config', mcpPath);
  c.agents.defaults.cliBackends['claude-cli'].args = filtered;
} else {
  // No MCP servers — remove flags if present
  if (c.agents?.defaults?.cliBackends?.['claude-cli']?.args) {
    const args = c.agents.defaults.cliBackends['claude-cli'].args;
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--mcp-config') { i++; continue; }
      if (args[i] === '--strict-mcp-config') continue;
      filtered.push(args[i]);
    }
    c.agents.defaults.cliBackends['claude-cli'].args = filtered;
  }
}
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
}

# ── Supervisor ────────────────────────────────────────────────
# Runs OpenClaw as a child process. On SIGUSR1, gracefully stops
# OpenClaw, re-generates config (picks up new Fly secrets as env
# vars), and restarts it. On SIGTERM, shuts down cleanly.

export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"

# Bridge IPv6 -> IPv4 (Fly 6PN)
socat TCP6-LISTEN:18790,fork,reuseaddr,bind=[::] TCP4:127.0.0.1:18789 &
SOCAT_PID=$!

OPENCLAW_PID=0
RESTART_REQUESTED=0

handle_sigusr1() {
    echo "[supervisor] SIGUSR1 received — restarting OpenClaw"
    RESTART_REQUESTED=1
    if [ $OPENCLAW_PID -ne 0 ]; then
        kill -TERM $OPENCLAW_PID 2>/dev/null || true
    fi
}

handle_sigterm() {
    echo "[supervisor] SIGTERM received — shutting down"
    if [ $OPENCLAW_PID -ne 0 ]; then
        kill -TERM $OPENCLAW_PID 2>/dev/null || true
        wait $OPENCLAW_PID 2>/dev/null || true
    fi
    kill $SOCAT_PID 2>/dev/null || true
    exit 0
}

trap handle_sigusr1 USR1
trap handle_sigterm TERM INT

while true; do
    RESTART_REQUESTED=0

    # (Re)generate config on every start — picks up new env vars from Fly secrets
    generate_config

    echo "[supervisor] Starting OpenClaw gateway on 0.0.0.0:18789 (IPv6 bridge on :18790)"
    node /app/openclaw/dist/index.js gateway &
    OPENCLAW_PID=$!

    # Wait for OpenClaw to exit (wait is interrupted by signals)
    wait $OPENCLAW_PID 2>/dev/null || true
    EXIT_CODE=$?

    if [ $RESTART_REQUESTED -eq 1 ]; then
        echo "[supervisor] Restarting OpenClaw in 2s..."
        sleep 2
        continue
    fi

    # OpenClaw exited on its own (crash or clean exit)
    echo "[supervisor] OpenClaw exited with code $EXIT_CODE — shutting down"
    kill $SOCAT_PID 2>/dev/null || true
    exit $EXIT_CODE
done
```

**Step 2: Test locally**

Run: `make image-build`
Expected: Docker image builds successfully.

**Step 3: Commit**

```bash
git add openclaw-image/entrypoint.sh
git commit -m "feat: refactor entrypoint to supervisor pattern with MCP config generation"
```

---

## Task 4: Webapp — GitHub OAuth API Routes

**Files:**
- Create: `webapp/src/app/api/integrations/github/connect/route.ts`
- Create: `webapp/src/app/api/integrations/github/callback/route.ts`
- Create: `webapp/src/app/api/integrations/github/disconnect/route.ts`

**Step 1: Create the connect route**

Create `webapp/src/app/api/integrations/github/connect/route.ts`:

```typescript
import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3020';

  // Build HMAC-signed state: timestamp.user_id.signature
  const ts = Date.now().toString();
  const sig = createHmac('sha256', GATEWAY_API_KEY)
    .update(`${ts}.${user.id}`)
    .digest('hex');
  const state = `${ts}.${user.id}.${sig}`;

  const redirectUri = `${APP_URL}/api/integrations/github/callback`;
  const scopes = 'repo,read:user';

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });

  return NextResponse.json({
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  });
}
```

**Step 2: Create the callback route**

Create `webapp/src/app/api/integrations/github/callback/route.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function verifyState(state: string, secret: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;

  const [ts, userId, sig] = parts;
  const age = Date.now() - Number(ts);
  if (isNaN(age) || age < 0 || age > STATE_MAX_AGE_MS) return null;

  const expected = createHmac('sha256', secret)
    .update(`${ts}.${userId}`)
    .digest('hex');

  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  return userId;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
  const GATEWAY_URL = process.env.GATEWAY_URL ?? '';
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3020';

  if (error) {
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=${error}`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=missing_params`);
  }

  // Verify CSRF state
  const stateUserId = verifyState(state, GATEWAY_API_KEY);
  if (!stateUserId) {
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=invalid_state`);
  }

  // Verify current user matches state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== stateUserId) {
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=unauthorized`);
  }

  // Exchange code for access token
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenResp.json();
  if (tokenData.error) {
    console.error('[github/callback] Token exchange failed:', tokenData.error);
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=token_exchange`);
  }

  // Fetch GitHub user info for display_name
  const userResp = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const githubUser = await userResp.json();

  // Upsert integrations row
  const serviceClient = createServiceClient();
  const { error: dbError } = await serviceClient
    .from('integrations')
    .upsert(
      {
        user_id: user.id,
        service: 'github',
        status: 'active',
        access_token: tokenData.access_token,
        scopes: tokenData.scope ?? '',
        external_id: String(githubUser.id ?? ''),
        display_name: githubUser.login ?? '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,service' }
    );

  if (dbError) {
    console.error('[github/callback] DB upsert failed:', dbError);
    return NextResponse.redirect(`${APP_URL}/connections?status=error&service=github&reason=db_error`);
  }

  // Inject GitHub token as Fly secret on user's machine
  if (GATEWAY_URL && GATEWAY_API_KEY) {
    try {
      const injectResp = await fetch(`${GATEWAY_URL}/api/integrations/inject-secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({
          user_id: user.id,
          service: 'github',
          secrets: { GITHUB_TOKEN: tokenData.access_token },
        }),
      });

      if (!injectResp.ok) {
        console.error('[github/callback] Secret injection failed:', await injectResp.text());
      }
    } catch (err) {
      console.error('[github/callback] Secret injection error:', err);
    }
  }

  return NextResponse.redirect(`${APP_URL}/connections?status=connected&service=github`);
}
```

**Step 3: Create the disconnect route**

Create `webapp/src/app/api/integrations/github/disconnect/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
  const GATEWAY_URL = process.env.GATEWAY_URL ?? '';

  // Mark as revoked in DB
  const serviceClient = createServiceClient();
  await serviceClient
    .from('integrations')
    .update({ status: 'revoked' })
    .eq('user_id', user.id)
    .eq('service', 'github');

  // Remove secrets from Fly machine
  if (GATEWAY_URL && GATEWAY_API_KEY) {
    try {
      await fetch(`${GATEWAY_URL}/api/integrations/remove-secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({
          user_id: user.id,
          service: 'github',
        }),
      });
    } catch (err) {
      console.error('[github/disconnect] Remove secrets error:', err);
    }
  }

  return NextResponse.json({ success: true });
}
```

**Step 4: Commit**

```bash
git add webapp/src/app/api/integrations/
git commit -m "feat: add GitHub OAuth API routes (connect, callback, disconnect)"
```

---

## Task 5: Webapp — Generic `ServiceConnection` Component

Reusable component for connect/disconnect UI. Adding a new service is just adding an entry to a config array.

**Files:**
- Create: `webapp/src/components/connections/service-connection.tsx`

**Step 1: Create the component**

Create `webapp/src/components/connections/service-connection.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type ServiceStatus = {
  connected: boolean;
  username?: string | null;
  displayName?: string | null;
  scopes?: string | null;
  connectedAt?: string | null;
};

type ServiceConfig = {
  id: string;
  name: string;
  description: string;
  connectedDescription: string;
  icon: React.ReactNode;
  connectEndpoint: string;
  disconnectEndpoint: string;
};

export function ServiceConnection({ config, initialStatus, message }: {
  config: ServiceConfig;
  initialStatus: ServiceStatus | null;
  message?: { type: 'success' | 'error'; text: string } | null;
}) {
  const [status, setStatus] = useState<ServiceStatus | null>(initialStatus);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [msg, setMsg] = useState(message ?? null);

  async function handleConnect() {
    setLoading(true);
    try {
      const resp = await fetch(config.connectEndpoint, { method: 'POST' });
      if (!resp.ok) {
        setMsg({ type: 'error', text: `Failed to start ${config.name} connection.` });
        return;
      }
      const { url } = await resp.json();
      window.location.href = url;
    } catch {
      setMsg({ type: 'error', text: `Failed to connect ${config.name}.` });
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const resp = await fetch(config.disconnectEndpoint, { method: 'POST' });
      if (resp.ok) {
        setStatus({ connected: false });
        setMsg({ type: 'success', text: `${config.name} disconnected.` });
      } else {
        setMsg({ type: 'error', text: `Failed to disconnect ${config.name}.` });
      }
    } catch {
      setMsg({ type: 'error', text: `Failed to disconnect ${config.name}.` });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted">
            {config.icon}
          </div>
          <div>
            <h3 className="text-sm font-medium">{config.name}</h3>
            <p className="text-xs text-muted-foreground">
              {status?.connected ? config.connectedDescription : config.description}
            </p>
          </div>
        </div>
        {status?.connected && (
          <Badge variant="secondary">Connected</Badge>
        )}
      </div>

      {msg && (
        <div
          className={`rounded-md p-3 text-sm ${
            msg.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-destructive/10 text-destructive'
          }`}
          role={msg.type === 'error' ? 'alert' : 'status'}
        >
          {msg.text}
        </div>
      )}

      {status?.connected ? (
        <div className="space-y-3">
          {(status.username || status.displayName) && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Account</span>
              <span className="font-medium">{status.username ?? status.displayName}</span>
            </div>
          )}
          {status.connectedAt && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Connected</span>
              <span>
                {new Date(status.connectedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handleConnect}
          disabled={loading}
        >
          {loading ? 'Connecting...' : `Connect ${config.name}`}
        </Button>
      )}
    </section>
  );
}
```

**Step 2: Commit**

```bash
git add webapp/src/components/connections/service-connection.tsx
git commit -m "feat: add generic ServiceConnection component"
```

---

## Task 6: Webapp — `/connections` Page

**Files:**
- Create: `webapp/src/app/(app)/connections/page.tsx`
- Create: `webapp/src/app/(app)/connections/connections-client.tsx`

**Step 1: Create the server component (page.tsx)**

Create `webapp/src/app/(app)/connections/page.tsx`:

```tsx
import { checkAccess } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { ConnectionsClient } from './connections-client';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; service?: string; reason?: string }>;
}) {
  const { user } = await checkAccess();
  const params = await searchParams;

  // Fetch all active integrations for this user
  const serviceClient = createServiceClient();
  const { data: integrations } = await serviceClient
    .from('integrations')
    .select('service, status, display_name, scopes, created_at')
    .eq('user_id', user.id)
    .eq('status', 'active');

  // Build a map of service -> status
  const connectedServices: Record<string, {
    connected: boolean;
    username: string | null;
    scopes: string | null;
    connectedAt: string | null;
  }> = {};

  for (const row of integrations ?? []) {
    connectedServices[row.service] = {
      connected: true,
      username: row.display_name,
      scopes: row.scopes,
      connectedAt: row.created_at,
    };
  }

  return (
    <ConnectionsClient
      connectedServices={connectedServices}
      statusParam={params.status ?? null}
      serviceParam={params.service ?? null}
      reasonParam={params.reason ?? null}
    />
  );
}
```

**Step 2: Create the client component**

Create `webapp/src/app/(app)/connections/connections-client.tsx`:

```tsx
'use client';

import { Github } from 'lucide-react';
import { ServiceConnection } from '@/components/connections/service-connection';

type ServiceStatus = {
  connected: boolean;
  username: string | null;
  scopes: string | null;
  connectedAt: string | null;
};

const SERVICES = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Let your agent manage repositories, issues, and pull requests.',
    connectedDescription: 'Your agent can access your GitHub repositories.',
    icon: <Github className="h-5 w-5" />,
    connectEndpoint: '/api/integrations/github/connect',
    disconnectEndpoint: '/api/integrations/github/disconnect',
  },
  // To add a new service, just add an entry here:
  // {
  //   id: 'google_drive',
  //   name: 'Google Drive',
  //   description: 'Let your agent read and create documents in Google Drive.',
  //   connectedDescription: 'Your agent can access your Google Drive.',
  //   icon: <SomeIcon className="h-5 w-5" />,
  //   connectEndpoint: '/api/integrations/google_drive/connect',
  //   disconnectEndpoint: '/api/integrations/google_drive/disconnect',
  // },
];

type ConnectionsClientProps = {
  connectedServices: Record<string, ServiceStatus>;
  statusParam: string | null;
  serviceParam: string | null;
  reasonParam: string | null;
};

export function ConnectionsClient({
  connectedServices,
  statusParam,
  serviceParam,
  reasonParam,
}: ConnectionsClientProps) {
  function getMessage(serviceId: string) {
    if (serviceParam !== serviceId) return null;
    if (statusParam === 'connected') {
      return { type: 'success' as const, text: 'Connected successfully.' };
    }
    if (statusParam === 'error') {
      return { type: 'error' as const, text: `Connection failed: ${reasonParam ?? 'unknown error'}` };
    }
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Connect third-party services to give your agent access to external tools.
        </p>
      </div>

      <div className="space-y-4">
        {SERVICES.map((service) => (
          <ServiceConnection
            key={service.id}
            config={service}
            initialStatus={connectedServices[service.id] ?? { connected: false }}
            message={getMessage(service.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add webapp/src/app/(app)/connections/
git commit -m "feat: add /connections page with GitHub integration"
```

---

## Task 7: Webapp — Add Connections to Sidebar

**Files:**
- Modify: `webapp/src/components/shared/app-sidebar.tsx`

**Step 1: Add the Plug icon import**

In `webapp/src/components/shared/app-sidebar.tsx`, add `Plug` to the lucide-react import (around line 6):

```typescript
import {
  MessageSquarePlus,
  Trash2,
  LayoutDashboard,
  FolderOpen,
  Settings,
  MessageSquare,
  Plug,
} from "lucide-react";
```

**Step 2: Add the Connections menu item**

Insert a new `<SidebarMenuItem>` between the Files and Settings items (after the Files `</SidebarMenuItem>` around line 176):

```tsx
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => router.push("/connections")}
                className="gap-2"
              >
                <Plug className="h-4 w-4" />
                Connections
              </SidebarMenuButton>
            </SidebarMenuItem>
```

**Step 3: Commit**

```bash
git add webapp/src/components/shared/app-sidebar.tsx
git commit -m "feat: add Connections link to sidebar navigation"
```

---

## Task 8: Pre-PR Verification

**Step 1: Run the full check**

Run: `make check`
Expected: webapp build + webapp lint + gateway lint all pass.

**Step 2: Test the full flow locally (manual)**

1. Register a GitHub OAuth App at github.com → Settings → Developer Settings → OAuth Apps
   - Callback URL: `http://localhost:3020/api/integrations/github/callback`
2. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `webapp/.env.local`
3. Run `make webapp-dev` and `make gateway-dev`
4. Go to `/connections`
5. Click "Connect GitHub" → authorize on GitHub → verify redirect with success message
6. Verify disconnect works
7. Check Supabase `integrations` table for the row

**Step 3: Commit any fixes and push**

```bash
git push origin HEAD
```

---

## Adding a New Service (Future Reference)

To add a new service (e.g., Webflow):

1. **Migration** — add to `valid_service` CHECK constraint (or new migration to ALTER it)
2. **Gateway** — add secret keys to `SERVICE_SECRET_KEYS` in `gateway/app/routes/integration_oauth.py`
3. **API routes** — create `webapp/src/app/api/integrations/{service}/` with connect, callback, disconnect routes
4. **MCP config** — add `if` block in `entrypoint.sh` for the new env var
5. **UI** — add entry to `SERVICES` array in `connections-client.tsx`
6. **Env vars** — set OAuth client ID + secret
