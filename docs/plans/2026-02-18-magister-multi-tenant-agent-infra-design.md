# Magister Multi-Tenant Agent Infrastructure Design

**Date:** 2026-02-18
**Status:** Draft
**Authors:** Elliot Eckholm

## Overview

Design for the backend infrastructure that powers Magister Marketing — a B2B SaaS where each customer ($299/mo) gets an isolated, autonomous AI marketing agent powered by OpenClaw. Agents execute real marketing work: SEO audits, landing page copy, ad campaign management, email sequences, and more — with full shell access for code execution and browser automation.

**Scope:** Backend infrastructure only (not the Next.js frontend or chat UI).

### Requirements

- Each user gets their own OpenClaw agent instance
- Full isolation: compute, storage, network, secrets — one user can't crash, read, or affect another
- Full shell access: agents run bash, browse the web, write files
- Zero setup for users: sign up, pay, start chatting
- 10-50 concurrent users initially (early access)
- Magister provides LLM API keys (cost baked into pricing)
- Per-user token/cost control and monitoring

### Non-Goals

- Frontend/chat UI implementation
- Marketing skill development
- Multi-region for individual users
- Self-hosted ($24,999) tier infrastructure

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Vercel                                                      │
│                                                              │
│  Next.js App                                                 │
│  ├── Frontend (React, Chat UI)                               │
│  ├── Auth (Supabase)                                         │
│  ├── Billing dashboard / Admin panel                         │
│  └── Lightweight API routes:                                 │
│      ├── /api/auth/*     (Supabase hooks)                    │
│      ├── /api/billing/*  (Stripe webhooks)                   │
│      └── /api/waitlist/* (signup)                            │
│                                                              │
│  Does NOT handle agent communication                         │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   │ HTTPS (public)
                   │
┌──────────────────┴───────────────────────────────────────────┐
│  Fly.io                                                      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Agent Gateway  (gateway.internal)                      │ │
│  │  Python / FastAPI — always-on, min 2 machines           │ │
│  │                                                         │ │
│  │  Chat & Lifecycle API (JWT-authenticated):              │ │
│  │  ├── POST /api/chat       Stream messages to/from agent │ │
│  │  ├── GET  /api/status     Machine state + LLM spend     │ │
│  │  ├── POST /api/provision  Create user machine           │ │
│  │  ├── POST /api/destroy    Tear down user machine        │ │
│  │  ├── GET  /health         Health check                  │ │
│  │  │                                                      │ │
│  │  LLM Proxy (machine-token-authenticated):               │ │
│  │  ├── POST /llm/v1/chat/completions  OpenAI-compatible   │ │
│  │  ├── Per-user budget enforcement via usage_events       │ │
│  │  ├── Token counting and cost tracking                   │ │
│  │  ├── Model access control per plan                      │ │
│  │  └── Uses litellm library for model routing             │ │
│  │  │                                                      │ │
│  │  Background:                                            │ │
│  │  ├── Idle sweep (suspend after 10min)                   │ │
│  │  └── Budget spend cache (30s TTL)                       │ │
│  └───────────────┬─────────────────────────────────────────┘ │
│                  │                                           │
│          Private network (*.internal)                        │
│                  │                                           │
│  ┌───────────────┴─────────────────────────────────────────┐ │
│  │  User Machines (one Fly App per customer)               │ │
│  │                                                         │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │ │
│  │  │ magister-   │  │ magister-   │  │ magister-   │     │ │
│  │  │ user-abc    │  │ user-def    │  │ user-ghi    │ ... │ │
│  │  │             │  │             │  │             │     │ │
│  │  │  OpenClaw   │  │  OpenClaw   │  │  OpenClaw   │     │ │
│  │  │  Gateway    │  │  Gateway    │  │  Gateway    │     │ │
│  │  │  :18789     │  │  :18789     │  │  :18789     │     │ │
│  │  │             │  │             │  │             │     │ │
│  │  │  LLM calls → Gateway /llm/v1/* (via internal)  │     │ │
│  │  │             │  │             │  │             │     │ │
│  │  │  Volume:    │  │  Volume:    │  │  Volume:    │     │ │
│  │  │  /data 5GB  │  │  /data 5GB  │  │  /data 5GB  │     │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Key Architectural Decision: Combined Gateway + LLM Proxy

The Agent Gateway serves dual roles — it proxies chat messages between the frontend and user machines, AND it serves as the LLM proxy that user machines call for AI completions. This is a single FastAPI service using `litellm` as a Python library rather than a separate proxy deployment.

**Why combined:**
- LiteLLM is a Python library — importing it directly eliminates a separate Fly app and network hop
- Single deployment: one Dockerfile, one fly.toml, one CI workflow
- Budget enforcement uses the same Supabase connection already available in the Gateway
- The Gateway already authenticates user machines via per-machine tokens — reused for LLM auth

**Two authentication paths on one service:**
1. **JWT auth** (Supabase) — for browser/Vercel requests: `/api/chat`, `/api/status`, `/api/provision`, `/api/destroy`
2. **Machine token auth** — for user machine requests: `/llm/v1/chat/completions`

### One App Per Customer (Fly.io Pattern)

Following [Fly.io's recommended pattern](https://fly.io/docs/machines/guides-examples/one-app-per-user-why/), each user gets their own Fly App containing one Machine:

- **Load balancing** and config are scoped per app
- **Secrets** live at the app level — a compromised user app cannot see other users' secrets
- **Network isolation** — per-machine bearer tokens authenticate all internal requests (note: apps in the same org share 6PN by default; see Open Questions for custom network options)
- **Independent scaling** — each app scales without affecting others
- **Clean logging** — per-app log separation

---

## Isolation Guarantees

| Boundary | Technology | What it protects |
|---|---|---|
| **Compute** | Firecracker microVM per user | Own kernel, own filesystem — no shared OS |
| **Network** | Per-machine bearer token (defense-in-depth) | All apps in the same Fly org share 6PN by default — bearer tokens are the primary isolation mechanism. User machines authenticate all requests to/from the Gateway. See Open Questions for custom network isolation. |
| **Secrets** | Fly app-level secret scoping | Compromised machine can't read other apps' secrets |
| **Storage** | Separate Fly Volume per user | Independent 5GB persistent disk |
| **Crash** | Separate machines | One user's crash doesn't affect others |
| **LLM Cost** | Gateway budget enforcement via usage_events | Per-user budgets with hard stops; tracked per-request |
| **VM Escape** | Firecracker (same as AWS Lambda) | Hardened hypervisor-level isolation |

---

## Component Details

### Agent Gateway

A Python/FastAPI service (~600 lines) deployed with `min_machines_running = 2` on Fly.io for high availability. It handles both chat proxying and LLM proxying. All intelligence lives in OpenClaw inside user machines — the Gateway is intentionally thin. Uses the async Supabase client (`acreate_client`) to avoid blocking the event loop. All services are initialized in FastAPI's `lifespan` context manager, not at module level.

**High availability:** Two Gateway instances run behind Fly's load balancer. Since the Gateway is stateless (reads all state from Supabase), requests can hit either instance. The idle sweep uses `SELECT ... FOR UPDATE SKIP LOCKED` to prevent duplicate suspend calls from concurrent instances — each instance claims different idle machines.

**Chat proxy responsibilities:**
- Authenticate browser requests (verify Supabase JWT)
- Look up user → machine mapping in Supabase
- Wake suspended machines before forwarding messages
- Buffer messages during machine wake-up (~300ms)
- Stream OpenClaw responses back to client via SSE
- Track `last_activity` per user for idle suspension (debounced — update at most once per 30s per user, not per SSE chunk)
- Per-user rate limiting (max 20 requests/min to `/api/chat`)
- Health check user machines after resume before forwarding first message

**LLM proxy responsibilities:**
- Authenticate user machine requests (verify per-machine bearer token)
- Check per-user monthly budget before forwarding LLM calls
- Call `litellm.acompletion()` with Magister's real Anthropic API key
- Pass `stream_options={"include_usage": True}` so streaming responses include token counts in the final chunk
- Stream LLM responses back to user machines
- Count tokens and record usage in `usage_events` (using `math.ceil()` for cost to avoid rounding sub-cent amounts to zero)
- Enforce model allowlists per plan
- Cache monthly spend in-memory (30s TTL) to avoid per-request DB queries

**Background jobs:**
- Idle sweep: suspend machines after 10min of inactivity (runs every 2min)
- Spend cache cleanup (automatic via TTL)

**Why SSE from Gateway to client (not WebSocket):**
- Works over standard HTTP — simple to deploy anywhere
- Unidirectional streaming is sufficient (user POSTs messages, receives streamed responses)
- No persistent connection to manage when user closes tab
- Stateless: each message = new POST + new SSE stream

**Machine lifecycle management:**
- `auto_stop_machines = "off"` — Fly never auto-suspends (it only monitors HTTP traffic, not agent activity)
- `auto_start_machines = true` — Fly wakes machines on incoming requests (safety net)
- The Gateway manages suspend/resume based on application-level activity signals
- While OpenClaw is actively working (web searches, code execution), response chunks keep resetting the idle timer

```python
# Idle sweep — runs every 2 minutes via asyncio
# Uses FOR UPDATE SKIP LOCKED so multiple Gateway instances can run
# concurrently without duplicating work (each claims different machines)
async def sweep_idle_machines(fly: FlyClient, supabase: SupabaseService):
    threshold = datetime.now(timezone.utc) - timedelta(minutes=10)
    # Atomically claim idle machines via Postgres function
    claimed = await supabase.claim_idle_machines(threshold, batch_size=10)

    for machine in claimed:
        if not machine.fly_machine_id:
            continue

        # Check heartbeat — machine may be working silently
        if await check_machine_heartbeat(machine):
            await supabase.update_user_machine(machine.id, status="running")
            await supabase.update_last_activity(machine.user_id)
            continue

        await fly.suspend_machine(machine.fly_app_name, machine.fly_machine_id)
        await supabase.update_user_machine(machine.id, status="suspended")
```

### LLM Budget Management

Instead of a separate LiteLLM proxy service, the Gateway uses `litellm` as a Python library and manages budgets directly via the `usage_events` table in Supabase.

**Budget and model configuration per plan:**
- `cmo` plan ($299/mo): $50/mo LLM budget, allowed models: `[claude-sonnet-4-6, claude-haiku-4-5]`
- `cmo_plus` plan ($999/mo): $150/mo LLM budget, allowed models: `[claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6]`

Model access is enforced per-plan — the Gateway checks both the budget AND the model allowlist for the user's specific plan. A `cmo` user cannot access Opus even if they have budget remaining.

**Budget enforcement flow:**
1. User machine sends LLM request to Gateway `/llm/v1/chat/completions` with machine bearer token
2. Gateway validates token, looks up user from `user_machines` by token hash
3. Gateway checks cached monthly spend (30s TTL) vs plan budget
4. If within budget: calls `litellm.acompletion()` with Magister's real Anthropic key
5. Counts tokens from response, calculates cost, inserts `usage_event`
6. If over budget: returns `429` with friendly "monthly usage limit reached" message

**How user machines connect:**
Each machine's OpenClaw config points its LLM base URL at the Gateway:
```json
{
  "anthropic": {
    "baseUrl": "http://magister-gateway.internal:8080/llm/v1",
    "apiKey": "<per-machine-bearer-token>"
  }
}
```

The per-machine token serves as both chat-forwarding auth and LLM proxy auth. OpenClaw requires zero code changes — it sees a standard OpenAI-compatible API endpoint.

### User Machines (OpenClaw)

Each user gets a Fly Machine running a shared Docker image with user-specific state on a Volume.

**Machine spec:** shared-cpu-2x, 2GB RAM, 5GB Volume

**What lives in the Docker image (immutable, shared):**
- OpenClaw runtime + dependencies
- Chromium for browser automation
- Magister's 25 marketing skills
- Default agent config (model selection, tool policies, skill allowlists)
- Entrypoint script

**What lives on the Volume /data (per-user, persistent):**
- `~/.openclaw/openclaw.json` — user-specific config overrides
- `~/.openclaw/agents/*/sessions/` — conversation history (JSONL)
- `~/.openclaw/workspace/` — files the agent creates
- `~/.openclaw/memory/` — vector memory (LanceDB)
- Any files the agent writes during execution

**Entrypoint script:**
```bash
#!/bin/bash
OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"

# First boot: initialize config from defaults
if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
    mkdir -p "$OPENCLAW_HOME"
    cp -r /app/default-config/* "$OPENCLAW_HOME/"
fi

# Inject/refresh LLM config (machine token + gateway LLM proxy URL)
cat > "$OPENCLAW_HOME/credentials/llm-keys.json" <<EOF
{
  "anthropic": {
    "apiKey": "${MACHINE_AUTH_TOKEN}",
    "baseUrl": "${LLM_BASE_URL}"
  }
}
EOF

# Start OpenClaw gateway
exec node /app/dist/index.js gateway \
    --home "$OPENCLAW_HOME" \
    --host 0.0.0.0 \
    --port 18789
```

**Suspend/resume behavior:**
- Suspend saves full VM state (CPU registers, memory, file handles) to persistent storage
- Resume restores in ~300ms — OpenClaw process continues where it left off
- Constraint: 2GB RAM is the maximum for Fly suspend (no swap allowed)
- Suspended machines incur storage-only charges ($0 CPU/RAM)

---

## Data Model (Supabase)

```sql
-- Maps users to their Fly infrastructure
CREATE TABLE user_machines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Fly.io infrastructure
    fly_app_name    TEXT NOT NULL UNIQUE,
    fly_machine_id  TEXT,
    fly_volume_id   TEXT,
    fly_region      TEXT NOT NULL DEFAULT 'iad',

    -- Lifecycle state
    -- provisioning → running → suspending → suspended → running → ...
    -- provisioning → failed
    -- any → destroying → destroyed
    -- 'suspending' is a transient state used by the idle sweep's
    -- FOR UPDATE SKIP LOCKED to claim machines atomically
    status          TEXT NOT NULL DEFAULT 'provisioning',

    last_activity   TIMESTAMPTZ DEFAULT now(),

    -- Plan & limits
    plan            TEXT NOT NULL DEFAULT 'cmo',
    max_agents      INT NOT NULL DEFAULT 1,

    -- Internal auth (per-machine bearer token)
    -- gateway_token: plaintext, used by Gateway for chat forwarding (Gateway→Machine)
    -- gateway_token_hash: SHA-256 hash, used for LLM proxy auth lookup (Machine→Gateway)
    -- Both columns are service-role-only (not exposed via RLS SELECT policy)
    gateway_token       TEXT,
    gateway_token_hash  TEXT,

    -- Deploy tracking
    pending_image   TEXT,
    current_image   TEXT,

    -- Provisioning state machine
    provisioning_step INT DEFAULT 0,

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_status CHECK (status IN (
        'provisioning', 'running', 'suspending', 'suspended',
        'failed', 'destroying', 'destroyed'
    ))
);

-- Usage tracking for billing & analytics
-- LLM budget enforcement queries this table
CREATE TABLE usage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    event_type      TEXT NOT NULL,
    -- 'llm_request'     — tokens consumed (primary for budget enforcement)
    -- 'machine_minute'  — compute time
    -- 'tool_execution'  — web search, browser, shell

    model           TEXT,
    input_tokens    INT,
    output_tokens   INT,
    cost_cents      INT,

    duration_ms     INT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_user_machines_idle
    ON user_machines (last_activity)
    WHERE status = 'running';

CREATE INDEX idx_user_machines_user
    ON user_machines (user_id);

-- Critical for budget checks — queried on every LLM request (with 30s cache)
CREATE INDEX idx_usage_events_monthly_spend
    ON usage_events (user_id, created_at)
    WHERE event_type = 'llm_request';

CREATE INDEX idx_usage_events_billing
    ON usage_events (user_id, created_at);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER user_machines_updated_at BEFORE UPDATE ON user_machines
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Claim idle machines for suspension using FOR UPDATE SKIP LOCKED.
-- This replaces advisory locks which don't work with Supabase RPC
-- (each RPC call is its own transaction, so the lock releases immediately).
-- Multiple Gateway instances can safely call this concurrently — each
-- claims a different batch of idle machines.
CREATE OR REPLACE FUNCTION claim_idle_machines(
    idle_threshold TIMESTAMPTZ,
    batch_size INT DEFAULT 10
)
RETURNS SETOF user_machines AS $$
BEGIN
    RETURN QUERY
    UPDATE user_machines
    SET status = 'suspending'
    WHERE id IN (
        SELECT id FROM user_machines
        WHERE status = 'running'
          AND last_activity < idle_threshold
        ORDER BY last_activity ASC
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Helper: get current month's LLM spend for a user (used by budget checks)
CREATE OR REPLACE FUNCTION get_monthly_llm_spend(p_user_id UUID)
RETURNS INT AS $$
BEGIN
    RETURN COALESCE(
        (SELECT SUM(cost_cents) FROM usage_events
         WHERE user_id = p_user_id
           AND event_type = 'llm_request'
           AND created_at >= date_trunc('month', now())),
        0
    );
END;
$$ LANGUAGE plpgsql;

-- Row Level Security (read-only for authenticated users, all writes via service role)
ALTER TABLE user_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own machine info, but NOT token columns.
-- The SELECT policy grants row access; column restriction is handled by
-- creating a view that excludes gateway_token and gateway_token_hash,
-- or by always querying specific columns from the frontend.
CREATE POLICY "Users read own machines" ON user_machines
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users read own usage" ON usage_events
    FOR SELECT USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for authenticated role
-- All writes go through the Gateway using the service_role key
```

---

## Secrets Management

Two layers of secrets (simplified from three by combining Gateway + LLM proxy):

### Layer 1: Platform Secrets (Magister's own)

Fly API token, Supabase service role key, Stripe secret key, **Anthropic API key**. Stored as Fly secrets on the Gateway app. Only the Gateway can access them. The real Anthropic key never leaves the Gateway — user machines use per-machine bearer tokens that the Gateway validates before making LLM calls on their behalf.

### Layer 2: User Integration Credentials

Google Ads, Meta Ads, Search Console, Ahrefs tokens. Stored as Fly secrets on each user's individual app. Set via the Magister UI → Gateway → Fly Secrets API. Never stored in Supabase or on Volumes.

**Write-only credential model:** Fly secrets can be set but never read back via the API. Even if the Fly API token is compromised, user credentials cannot be extracted.

### Internal Authentication (Gateway ↔ User Machines)

Each user machine has a per-machine bearer token set as a Fly secret (`MACHINE_AUTH_TOKEN`). This token is used bidirectionally:

```
Chat forwarding (Gateway → Machine):
Gateway looks up plaintext token from user_machines by user_id
Gateway → POST http://{machine}:18789/api/chat
           Authorization: Bearer {per-machine-token}

LLM proxying (Machine → Gateway):
Machine → POST http://magister-gateway.internal:8080/llm/v1/chat/completions
           Authorization: Bearer {per-machine-token}
```

The token is generated during provisioning and stored in `user_machines` in two forms: plaintext (`gateway_token`) for the Gateway to use when forwarding chat messages, and hashed (`gateway_token_hash`) for fast reverse-lookup when user machines call the LLM proxy. The token is also set as a Fly secret (`MACHINE_AUTH_TOKEN`) on the user's app so OpenClaw can include it in LLM requests.

Both token columns are only accessible via the service role key — the RLS `SELECT` policy for authenticated users does NOT expose them. This avoids storing tokens as Fly secrets on the Gateway (which would trigger restarts on every provision).

---

## Message Flow

**Concurrency:** The Gateway enforces one active chat request per user at a time. If a user sends a second message while the first is streaming, the Gateway returns `409 Conflict` with a message like "Your agent is still working on the previous task." The frontend disables the send button while a response is streaming.

```
User sends "Audit my SEO"
       │
  1.   │──POST /api/chat───────────────────────▶ Agent Gateway
       │  Authorization: Bearer <supabase-jwt>
       │
  2.   │                          Gateway verifies JWT
       │                          Looks up user_machines row
       │
  3.   │                          status == "suspended"?
       │◀── SSE: "Waking agent..." ──│
       │                              │──POST /machines/{id}/start──▶ Fly
       │                              │◀── 200 OK (running) ─────────┘
       │
  4.   │                          Update last_activity, status = "running"
       │
  5.   │                          Gateway forwards to OpenClaw:
       │                              │──POST http://{machine}:18789/api/chat
       │                              │
       │                              │  OpenClaw processes:
       │                              │  ├─ Calls Gateway /llm/v1/* (via internal)
       │                              │  │   └─ Gateway checks budget, calls Anthropic
       │                              │  ├─ Agent browses user's site
       │                              │  ├─ Analyzes SEO issues
       │                              │  └─ Streams results back
       │
  6.   │◀── SSE: stream chunks ──────│◀── response stream ──────────┘
       │    (reset last_activity       │
       │     on each chunk)            │
       │
  7.   │◀── SSE: { type: "done" } ───│
       │
       │         ... 10 min idle ...
       │
  8.   │                          Idle sweep fires
       │                              │──POST /machines/{id}/suspend─▶ Fly
       │                          Update status = "suspended"
```

---

## Provisioning Pipeline

Triggered by Stripe `checkout.session.completed` webhook.

Each step is idempotent. The `provisioning_step` column tracks progress so that retries skip completed steps. If any step fails, the Gateway sets `status = 'failed'` and a reconciliation job (runs every 5 minutes) cleans up partial resources.

```
1.  Vercel /api/billing/webhook receives Stripe event
2.  Creates user in Supabase (if needed), sets plan
3.  POST to Gateway /api/provision with user_id

Gateway executes in sequence (each step updates provisioning_step):
4.  [step 1] Insert user_machines row: status = "provisioning"
5.  [step 2] Create Fly App: magister-user-{userId}
6.  [step 3] Generate per-machine auth token, store hash in Supabase,
             AND set Fly secrets on user app in one step (prevents token
             loss if failure occurs between generation and secret-setting)
7.  [step 4] Create Fly Volume: 5GB in region 'iad'
8.  [step 5] Create Fly Machine: shared-cpu-2x, 2GB RAM, mount volume at /data
9.  [step 6] Wait for machine status = "started", health check passes
10. [step 7] Update user_machines: status = "running", current_image = "..."

Note: No Gateway-side token storage. The Gateway looks up machine tokens
from Supabase by user_id (for chat forwarding) or by token_hash (for LLM
proxy auth). This avoids restarting the Gateway on every provision.

On failure at any step:
- Set status = "failed", record error in metadata column
- Reconciliation job retries from the failed step or cleans up

Total time: ~10-15 seconds
```

### Teardown (subscription cancellation):

```
1.  Stripe customer.subscription.deleted webhook
2.  POST to Gateway /api/destroy
3.  (Optional) Export user data — zip workspace, offer download link
4.  Destroy machine, volume, and app via Fly API
5.  Update user_machines: status = "destroyed"
```

---

## Deployment Pipeline

### Repository Structure

```
magister-marketing/
├── webapp/              → Vercel (auto-deploy on push)
├── gateway/             → Fly.io "magister-gateway" app
└── openclaw-image/      → Fly.io Registry (shared Docker image)
```

### Gateway Deploys

Standard Fly deployment. Push to main triggers CI:
```
CI → run tests → fly deploy --app magister-gateway → rolling restart
```

### OpenClaw Image Deploys (updating all user agents)

When marketing skills, OpenClaw version, or default config change:

```
CI → build Docker image → push to Fly registry

Rolling update script:
1. Canary: update 1 running machine, wait 2 min, verify health
2. If canary healthy → continue; if unhealthy → abort, rollback canary
3. Suspended machines: set pending_image flag, update current_image
   (picks up new image on next start — no need to wake them)
4. Running machines: wait for idle (last_activity > 2min ago),
   then PUT /machines/{id} with new image, verify health
5. Log results per machine
```

**Rollback:** If the new image is broken, re-run the deploy script with the previous image tag. The `current_image` column on `user_machines` tracks which version each machine is running for observability.

---

## Cost Analysis

### Per-User Cost (shared-cpu-2x, 2GB RAM, 5GB Volume)

| Component | Running 24/7 | Running ~2h/day (typical) |
|---|---|---|
| Compute | $23.87/mo | $1.99/mo |
| Volume (5GB) | $0.75/mo | $0.75/mo |
| **Subtotal** | **$24.62/mo** | **$2.74/mo** |

### Total Infrastructure Cost (Three Scenarios)

LLM costs vary significantly based on agent usage intensity. A single SEO audit with browsing and content generation can involve 20-50 LLM calls at $0.10-0.50 each.

**Low usage ($5/user/mo LLM — light users, few tasks):**

| | 10 users | 25 users | 50 users |
|---|---|---|---|
| Fly machines (2h/day active) | $27 | $69 | $137 |
| Agent Gateway (2 instances, always-on) | $48 | $48 | $48 |
| Fly IPv4 (gateway only) | $2 | $2 | $2 |
| Volume backups ($0.40/user/mo) | $4 | $10 | $20 |
| LLM API costs | $50 | $125 | $250 |
| Supabase | $0 | $25 | $25 |
| Vercel | $20 | $20 | $20 |
| **Total** | **$151/mo** | **$299/mo** | **$502/mo** |
| **Revenue** ($299/user) | $2,990 | $7,475 | $14,950 |
| **Gross Margin** | **95%** | **96%** | **97%** |

**Typical usage ($20/user/mo LLM — regular daily use):**

| | 10 users | 25 users | 50 users |
|---|---|---|---|
| Infrastructure (non-LLM) | $101 | $174 | $252 |
| LLM API costs | $200 | $500 | $1,000 |
| **Total** | **$301/mo** | **$674/mo** | **$1,252/mo** |
| **Gross Margin** | **90%** | **91%** | **92%** |

**Heavy usage ($40/user/mo LLM — power users near budget cap):**

| | 10 users | 25 users | 50 users |
|---|---|---|---|
| Infrastructure (non-LLM) | $101 | $174 | $252 |
| LLM API costs | $400 | $1,000 | $2,000 |
| **Total** | **$501/mo** | **$1,174/mo** | **$2,252/mo** |
| **Gross Margin** | **83%** | **84%** | **85%** |

No per-user IPv4 charges — user machines are accessed only via the Gateway's private network.

*Note: Compared to the previous 2-service architecture, eliminating the dedicated LiteLLM Fly app saves ~$24/mo in fixed costs.*

### Cost Risk: LLM Usage Spikes

Mitigations:
1. Default to Sonnet for most tasks (10x cheaper than Opus)
2. Gateway enforces monthly per-user budget caps ($50/mo default)
3. Alert users at 80% of their limit
4. Optional: overage billing via Stripe metered billing

### Suspend/Resume Economics

The 2GB RAM machine size is at the [maximum for Fly suspend](https://fly.io/docs/reference/suspend-resume/) (2GB limit, no swap). Suspend saves full VM state and costs $0 for CPU/RAM. If machines later need 4GB+, fall back to stop/start (~2s cold boot vs ~300ms resume).

---

## Monitoring

### Level 1: LLM Usage (Gateway Admin Endpoints)

- Spend per user (daily/weekly/monthly) — queried from `usage_events`
- Token usage per model
- Request counts and latency
- Budget utilization (% used)
- Rate-limited and budget-exceeded requests

### Level 2: Infrastructure (Fly.io Dashboard)

- Machine status per app (running/suspended/stopped)
- CPU/memory/network per machine
- Volume disk usage
- Uptime and restart history

### Level 3: Admin Dashboard (Magister Next.js App)

Aggregates both sources into a single view:

| User | Status | LLM Spend | Budget | Last Active |
|---|---|---|---|---|
| Acme Co | Running | $12.34 | $50/mo | 2 min ago |
| StartupX | Suspended | $3.21 | $50/mo | 3 hours ago |
| Agency9 | Running | $48.90 | $50/mo | Just now |

Data sources:
- Machine status → Fly Machines API
- LLM spend → `SELECT SUM(cost_cents) FROM usage_events WHERE ...`
- Last active → `user_machines.last_activity`

---

## Technology Stack Summary

| Component | Technology | Purpose |
|---|---|---|
| Frontend | Next.js on Vercel | Chat UI, billing, admin dashboard |
| Auth | Supabase | User accounts, JWT, RLS |
| Agent Gateway | Python / FastAPI on Fly.io | Chat proxy, LLM proxy (litellm), lifecycle, streaming, idle sweep, budget enforcement |
| User Machines | Fly.io Machines (2cpu/2GB) | Isolated OpenClaw per user |
| User Storage | Fly Volumes (5GB each) | Sessions, workspace, memory |
| Secrets | Fly app-level secrets | Anthropic key (gateway only) + user integrations |
| Database | Supabase (Postgres) | user_machines, usage_events |
| Billing | Stripe | Subscriptions, webhooks |
| Email | Resend | Transactional emails |
| CI/CD | GitHub Actions | Build + deploy gateway and OpenClaw image |

---

## Launch Requirements (Must Address Before GA)

1. **Volume backups** — Fly Volumes are not automatically backed up. Losing user data at $299/month is a churn event. Implement nightly volume snapshots via `fly volumes snapshots create` ($0.08/GB/mo = $0.40/user/mo). Additionally, sync critical state (session history, config) to object storage (Tigris/S3) periodically so a new volume can be bootstrapped from backup.

2. **Fly suspend testing** — Community reports stale TCP connections after resume. Test OpenClaw specifically: does the Gateway LLM proxy connection survive resume? Does the browser automation reconnect? Implement connection retry logic in the entrypoint script if needed.

3. **Centralized logging & alerting** — Ship logs from all user machines and the Gateway to a centralized service (Fly's built-in log shipping → Grafana/Loki, or Betterstack). Set up alerts for: Gateway errors, machine startup failures, LLM budget exhaustion, and disk usage > 80%.

4. **Gateway deploy graceful shutdown** — Rolling restarts of the Gateway will terminate in-flight SSE streams. Implement graceful drain: on SIGTERM, stop accepting new requests, wait for active streams to complete (with a timeout), then exit. Fly supports this via `kill_timeout` in fly.toml. Uvicorn supports graceful shutdown natively.

## Open Questions

1. **Fly 6PN network isolation** — Confirmed: all apps in the same Fly org share the default 6PN network. User machines CAN resolve each other's `.internal` addresses. The per-machine bearer token is therefore the **primary** network isolation mechanism, not defense-in-depth. Options: (a) Accept this and rely on bearer tokens (current approach), (b) Use Fly's custom private networks (`fly network create`) to isolate each user app, or (c) Place user apps in separate Fly orgs. Decision needed before GA.
2. **CMO+ plan (10 agents)** — The $999/mo tier promises 10+ agents. Architecture supports this (multiple machines per app), but provisioning and lifecycle management need to handle multi-machine apps.
3. **User data export** — When a user cancels, should we zip their workspace and offer a download? Need to define data retention policy.
4. **Regional failover** — All users currently pin to `iad`. If Fly has a regional outage, all users go down. Evaluate multi-region Gateway deployment and failover strategy before scaling beyond 50 users.
5. **Supabase dependency** — The Gateway depends on Supabase for JWT verification and machine lookup on every request. A Supabase outage means total platform outage. Consider caching machine lookups in-memory with a short TTL.
6. **Resume failure recovery** — What if a machine fails to resume from suspend? Define the user experience: retry once, then fall back to cold start (stop/start), then surface error with support link.
7. **`usage_events` retention** — Table will grow unbounded. Add time-based partitioning (monthly) and archive events older than 90 days to a summary table.
8. **LLM proxy latency** — The Gateway adds a network hop to every LLM call (machine → gateway → Anthropic). Measure P95 latency overhead. At ~1ms internal network latency on Fly, this should be negligible compared to LLM response times (seconds), but worth confirming.
9. **Per-user concurrency lock scope** — The `active_requests` set (one chat at a time per user) is per-Gateway-instance. With 2 instances, a user could theoretically hit both and have 2 concurrent chats. Options: (a) Accept as low-risk edge case, (b) Use a Supabase-backed lock, (c) Use Fly's request affinity to pin users to instances.
10. **Reconciliation job** — The provisioning pipeline mentions a reconciliation job that cleans up partial resources from failed provisions. This needs to be implemented as a background task (similar to idle sweep) that runs every 5 minutes.
11. **Fly API retry logic** — The FlyClient should implement retries with exponential backoff for transient failures (5xx, timeouts). Currently, a single failed Fly API call fails the entire provisioning step.
