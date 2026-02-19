# Multi-Tenant Agent Infrastructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the backend infrastructure that gives each Magister customer an isolated OpenClaw agent on Fly.io, managed by a combined Agent Gateway + LLM Proxy (single FastAPI service), with per-user LLM cost control via litellm (library).

**Architecture:** One Fly App per customer containing a Firecracker microVM running OpenClaw. A single Agent Gateway (FastAPI on Fly.io) proxies chat messages, manages machine lifecycle (suspend/resume), enforces auth, AND serves as the LLM proxy that user machines call for AI completions. Budget enforcement and token tracking use the `usage_events` table in Supabase. Stripe webhooks trigger provisioning/teardown.

**Tech Stack:** Python, FastAPI, litellm, httpx, Fly.io Machines API, Supabase (Postgres), Stripe, Docker, GitHub Actions

**Design Doc:** `docs/plans/2026-02-18-magister-multi-tenant-agent-infra-design.md`

**Repository:** `magister-marketing/` — new directories: `gateway/`, `openclaw-image/`

---

## Project Structure

```
magister-marketing/
├── webapp/                          (existing Next.js app on Vercel)
│   ├── supabase/migrations/         (existing + new migration)
│   └── src/app/api/billing/         (new Stripe webhook route)
│
├── gateway/                         (NEW — FastAPI Gateway + LLM Proxy on Fly.io)
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                  Entry point — FastAPI app + lifespan
│   │   ├── config.py                Pydantic Settings (env vars)
│   │   ├── models.py                Pydantic models (request/response)
│   │   ├── dependencies.py          Shared FastAPI dependencies
│   │   ├── routes/
│   │   │   ├── __init__.py
│   │   │   ├── chat.py              POST /api/chat — proxy + SSE streaming
│   │   │   ├── provision.py         POST /api/provision — create user infra
│   │   │   ├── destroy.py           POST /api/destroy — teardown user infra
│   │   │   ├── status.py            GET /api/status — machine state + spend
│   │   │   ├── health.py            GET /health — gateway health
│   │   │   └── llm_proxy.py         POST /llm/v1/chat/completions — OpenAI-compat
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── fly.py               Fly Machines API client (httpx)
│   │   │   ├── llm.py               litellm wrapper + budget checking
│   │   │   └── supabase_client.py   Supabase client (service role)
│   │   ├── middleware/
│   │   │   ├── __init__.py
│   │   │   ├── auth.py              JWT verification + machine token auth
│   │   │   └── rate_limit.py        Per-user rate limiting
│   │   └── jobs/
│   │       ├── __init__.py
│   │       └── idle_sweep.py        Background task — suspend idle machines
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_services/
│   │   │   ├── test_fly.py
│   │   │   └── test_llm.py
│   │   ├── test_routes/
│   │   │   ├── test_chat.py
│   │   │   └── test_provision.py
│   │   └── test_middleware/
│   │       └── test_auth.py
│   ├── Dockerfile
│   ├── fly.toml
│   ├── pyproject.toml
│   └── requirements.txt
│
├── openclaw-image/                  (NEW — Docker image for user machines)
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── default-config/
│       ├── openclaw.json
│       └── skills/                  (symlink or copy of marketingskills/)
│
├── docker-compose.yml               (NEW — local dev: Gateway + OpenClaw user machine)
├── .env.docker.example              (NEW — template for local dev env vars)
├── Makefile                         (NEW — root dev commands: make up, make down, make seed)
│
└── .github/
    └── workflows/
        ├── deploy-gateway.yml
        └── deploy-openclaw-image.yml
```

---

## Phase 1: Foundation (Supabase + Project Scaffold + Docker Local Dev)

### Task 1: Supabase Migration — user_machines & usage_events

**Files:**
- Create: `webapp/supabase/migrations/20260218000000_create_user_machines.sql`

**Step 1: Write the migration file**

```sql
-- User machine mapping and lifecycle
CREATE TABLE user_machines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    fly_app_name        TEXT NOT NULL UNIQUE,
    fly_machine_id      TEXT,
    fly_volume_id       TEXT,
    fly_region          TEXT NOT NULL DEFAULT 'iad',

    status              TEXT NOT NULL DEFAULT 'provisioning',
    last_activity       TIMESTAMPTZ DEFAULT now(),

    plan                TEXT NOT NULL DEFAULT 'cmo',
    max_agents          INT NOT NULL DEFAULT 1,

    -- Internal auth (per-machine bearer token)
    -- gateway_token: plaintext, used by Gateway for chat forwarding
    -- gateway_token_hash: SHA-256 hash, used for LLM proxy auth lookup
    gateway_token       TEXT,
    gateway_token_hash  TEXT,

    pending_image       TEXT,
    current_image       TEXT,
    provisioning_step   INT DEFAULT 0,

    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_status CHECK (status IN (
        'provisioning', 'running', 'suspending', 'suspended',
        'failed', 'destroying', 'destroyed'
    ))
);

CREATE TABLE usage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id),
    event_type      TEXT NOT NULL,
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

CREATE INDEX idx_user_machines_token_hash
    ON user_machines (gateway_token_hash)
    WHERE gateway_token_hash IS NOT NULL;

CREATE INDEX idx_usage_events_monthly_spend
    ON usage_events (user_id, created_at)
    WHERE event_type = 'llm_request';

CREATE INDEX idx_usage_events_billing
    ON usage_events (user_id, created_at);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_machines_updated_at
    BEFORE UPDATE ON user_machines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Claim idle machines for suspension using FOR UPDATE SKIP LOCKED.
-- Replaces advisory locks (which don't work via Supabase RPC because
-- each RPC is its own transaction, releasing the lock immediately).
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

-- Helper: get current month's LLM spend for a user
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

-- RLS: read-only for authenticated users, all writes via service_role
ALTER TABLE user_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own machines" ON user_machines
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users read own usage" ON usage_events
    FOR SELECT USING (auth.uid() = user_id);
```

**Step 2: Run migration against local Supabase**

```bash
cd webapp && make supabase-migrate-local
```

Expected: Migration applies successfully.

**Step 3: Verify tables exist**

```bash
make connect-local-db
# Then: \dt user_machines; \dt usage_events;
```

Expected: Both tables listed.

**Step 4: Commit**

```bash
git add webapp/supabase/migrations/20260218000000_create_user_machines.sql
git commit -m "feat: add user_machines and usage_events tables"
```

---

### Task 2: Scaffold Gateway Project

**Files:**
- Create: `gateway/pyproject.toml`
- Create: `gateway/requirements.txt`
- Create: `gateway/app/__init__.py`
- Create: `gateway/app/config.py`
- Create: `gateway/app/models.py`

**Step 1: Create pyproject.toml**

```toml
[project]
name = "magister-gateway"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

**Step 2: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn[standard]>=0.34.0
httpx>=0.28.0
python-jose[cryptography]>=3.3.0
supabase>=2.12.0           # provides acreate_client for async usage
litellm>=1.60.0
pydantic-settings>=2.7.0
sse-starlette>=2.2.0
```

**Step 3: Create app/config.py**

```python
# gateway/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    port: int = 8080

    # Fly.io
    fly_api_token: str
    fly_org: str

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # LLM (Anthropic key used by litellm directly)
    anthropic_api_key: str

    # OpenClaw image
    openclaw_image: str

    # Defaults
    default_region: str = "iad"
    default_budget_cents: int = 5000  # $50

    # Plan budgets (cents per month)
    plan_budgets: dict[str, int] = {
        "cmo": 5000,       # $50/mo
        "cmo_plus": 15000,  # $150/mo
    }

    # Per-plan model allowlists (CMO users cannot access Opus)
    plan_allowed_models: dict[str, list[str]] = {
        "cmo": ["claude-sonnet-4-6", "claude-haiku-4-5"],
        "cmo_plus": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
    }

    model_config = {"env_prefix": "", "case_sensitive": False}
```

**Step 4: Create app/models.py**

```python
# gateway/app/models.py
from pydantic import BaseModel
from enum import Enum


class MachineStatus(str, Enum):
    provisioning = "provisioning"
    running = "running"
    suspended = "suspended"
    failed = "failed"
    destroying = "destroying"
    destroyed = "destroyed"


class UserMachine(BaseModel):
    id: str
    user_id: str
    fly_app_name: str
    fly_machine_id: str | None = None
    fly_volume_id: str | None = None
    fly_region: str = "iad"
    status: MachineStatus = MachineStatus.provisioning
    last_activity: str | None = None
    plan: str = "cmo"
    max_agents: int = 1
    gateway_token: str | None = None       # plaintext — for chat forwarding
    gateway_token_hash: str | None = None   # SHA-256 — for LLM proxy auth lookup
    pending_image: str | None = None
    current_image: str | None = None
    provisioning_step: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class ProvisionRequest(BaseModel):
    user_id: str
    plan: str = "cmo"
    region: str = "iad"


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class LLMCompletionRequest(BaseModel):
    """OpenAI-compatible chat completion request."""
    model: str
    messages: list[dict]
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = None


class UsageEvent(BaseModel):
    user_id: str
    event_type: str  # 'llm_request', 'machine_minute', 'tool_execution'
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_cents: int | None = None
    duration_ms: int | None = None
    metadata: dict | None = None
```

**Step 5: Create empty `__init__.py`**

```python
# gateway/app/__init__.py
```

**Step 6: Install dependencies**

```bash
cd gateway && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

**Step 7: Commit**

```bash
git add gateway/
git commit -m "feat: scaffold gateway project with config and models"
```

---

### Task 3: Docker Local Dev Setup

The Gateway and user machines run in Docker everywhere — same image locally as on Fly.io. Docker Compose wires them together for local dev alongside the host-run Supabase.

**Files:**
- Create: `gateway/Dockerfile`
- Create: `gateway/app/main.py` (minimal — health endpoint only, routes added in Phase 2-3)
- Modify: `gateway/app/config.py` (make Fly-specific settings optional for local dev)
- Create: `docker-compose.yml` (root — Gateway + OpenClaw user machine)
- Create: `.env.docker.example` (template for local dev env vars)
- Create: `Makefile` (root — `make up`, `make down`, `make logs`, `make seed`)
- Create: `webapp/supabase/migrations/20260218000001_seed_dev_machine.sql` (seed data for local dev)
- Modify: `.gitignore` (add `.env.docker`)

**Network layout:**
- Gateway container: port 8080, connects to host Supabase via `host.docker.internal:54321`
- User machine container: port 18789, LLM calls go to `gateway:8080/llm/v1` on the Docker network
- Gateway forwards chat to `user-machine:18789` on the Docker network
- Gateway makes real Anthropic API calls via litellm (real API key required)

**Step 1: Update config.py — make Fly settings optional**

Fly-specific settings aren't needed for local dev (no provisioning/destroying via Fly API). Default to empty strings so the Gateway starts without them.

```python
class Settings(BaseSettings):
    port: int = 8080

    # Fly.io (optional for local dev — only needed for machine provisioning)
    fly_api_token: str = ""
    fly_org: str = ""

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # LLM (real Anthropic key required even for local dev)
    anthropic_api_key: str

    # OpenClaw image (used by Fly provisioning, not needed locally)
    openclaw_image: str = ""

    # ...rest unchanged
```

**Step 2: Create gateway/Dockerfile**

Same image runs locally and on Fly.io.

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

**Step 3: Create minimal gateway/app/main.py**

Just enough to start the container. Routes are added in Phase 2-3 as services are built.

```python
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import logging

from fastapi import FastAPI

from app.config import Settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Gateway starting on port {settings.port}")
    yield
    logger.info("Gateway shutting down")


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
```

**Step 4: Create docker-compose.yml**

User machine uses a pre-built OpenClaw image (set `OPENCLAW_IMAGE` in `.env.docker`).

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "8080:8080"
    env_file: .env.docker
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - magister
    depends_on:
      user-machine:
        condition: service_started

  user-machine:
    image: ${OPENCLAW_IMAGE}
    ports:
      - "18789:18789"
    environment:
      MACHINE_AUTH_TOKEN: ${DEV_MACHINE_TOKEN}
      LLM_BASE_URL: http://gateway:8080/llm/v1
      OPENCLAW_HOME: /data/.openclaw
    volumes:
      - openclaw-data:/data
    networks:
      - magister

networks:
  magister:

volumes:
  openclaw-data:
```

**Step 5: Create .env.docker.example**

```bash
# OpenClaw image (pre-built — set to your local or registry image)
OPENCLAW_IMAGE=your-openclaw-image:latest

# Supabase (local — via supabase start)
SUPABASE_URL=http://host.docker.internal:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
SUPABASE_JWT_SECRET=<from supabase status>

# LLM (real key required)
ANTHROPIC_API_KEY=sk-ant-...

# Dev machine token (must match seed migration)
DEV_MACHINE_TOKEN=dev-machine-token-local-unsafe
```

**Step 6: Create seed migration for local dev**

Create `webapp/supabase/migrations/20260218000001_seed_dev_machine.sql`:

Seeds a `user_machines` row so the Gateway knows about the local OpenClaw container. Uses a deterministic dev user ID and token hash.

```sql
-- Seed data for local development only.
-- Creates a test user_machines row pointing at the Docker Compose user-machine container.
-- The token hash matches DEV_MACHINE_TOKEN=dev-machine-token-local-unsafe from .env.docker.example.
--
-- To use: set DEV_MACHINE_TOKEN=dev-machine-token-local-unsafe in .env.docker

DO $$
DECLARE
    dev_user_id UUID;
BEGIN
    -- Only seed if no user_machines rows exist (prevents re-seeding in production)
    IF NOT EXISTS (SELECT 1 FROM public.user_machines LIMIT 1) THEN
        -- Use the first user in auth.users, or skip if none exist
        SELECT id INTO dev_user_id FROM auth.users LIMIT 1;

        IF dev_user_id IS NOT NULL THEN
            INSERT INTO public.user_machines (
                user_id, fly_app_name, fly_region, status,
                plan, gateway_token, gateway_token_hash
            ) VALUES (
                dev_user_id,
                'magister-dev-local',
                'local',
                'running',
                'cmo',
                'dev-machine-token-local-unsafe',
                encode(digest('dev-machine-token-local-unsafe', 'sha256'), 'hex')
            );
        END IF;
    END IF;
END $$;
```

**Step 7: Create root Makefile**

```makefile
.PHONY: up down logs seed reset

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

seed:
	cd webapp && make supabase-migrate-local

reset:
	cd webapp && make supabase-reset-local
	$(MAKE) seed
```

**Step 8: Add `.env.docker` to .gitignore**

**Step 9: Verify**

```bash
# 1. Start local Supabase
cd webapp && make supabase-start-local && make supabase-migrate-local

# 2. Copy env template
cp .env.docker.example .env.docker
# Edit .env.docker with real values (Anthropic key, Supabase keys from `supabase status`)

# 3. Start the stack
make up

# 4. Verify Gateway
curl http://localhost:8080/health
# Expected: {"status": "ok", "timestamp": "..."}

# 5. Verify user machine
curl http://localhost:18789/health
# Expected: OpenClaw health response
```

**Step 10: Commit**

```bash
git add gateway/Dockerfile gateway/app/main.py docker-compose.yml .env.docker.example Makefile \
  webapp/supabase/migrations/20260218000001_seed_dev_machine.sql .gitignore
git commit -m "feat: add Docker local dev setup with Gateway + OpenClaw containers"
```

---

## Phase 2: Gateway Core Services

### Task 4: Supabase Service Client

**Files:**
- Create: `gateway/app/services/supabase_client.py`

**Step 1: Write the implementation**

```python
# gateway/app/services/supabase_client.py
from datetime import datetime, timedelta, timezone
from supabase._async.client import AsyncClient, acreate_client

from app.models import UserMachine, UsageEvent


class SupabaseService:
    """Async Supabase client using acreate_client to avoid blocking the event loop.
    Must be initialized via the async create() factory, not __init__."""

    def __init__(self, client: AsyncClient):
        self.client = client

    @classmethod
    async def create(cls, url: str, service_role_key: str) -> "SupabaseService":
        client = await acreate_client(url, service_role_key)
        return cls(client)

    async def get_user_machine(self, user_id: str) -> UserMachine | None:
        result = await (
            self.client.table("user_machines")
            .select("*")
            .eq("user_id", user_id)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        if not result.data:
            return None
        return UserMachine(**result.data)

    async def get_user_machine_by_token_hash(self, token_hash: str) -> UserMachine | None:
        result = await (
            self.client.table("user_machines")
            .select("*")
            .eq("gateway_token_hash", token_hash)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        if not result.data:
            return None
        return UserMachine(**result.data)

    async def create_user_machine(self, data: dict) -> UserMachine:
        result = await (
            self.client.table("user_machines")
            .insert(data)
            .execute()
        )
        return UserMachine(**result.data[0])

    async def update_user_machine(self, machine_id: str, **updates) -> None:
        await (
            self.client.table("user_machines")
            .update(updates)
            .eq("id", machine_id)
            .execute()
        )

    async def update_last_activity(self, user_id: str) -> None:
        await (
            self.client.table("user_machines")
            .update({"last_activity": datetime.now(timezone.utc).isoformat()})
            .eq("user_id", user_id)
            .eq("status", "running")
            .execute()
        )

    async def claim_idle_machines(
        self, threshold: datetime, batch_size: int = 10
    ) -> list[UserMachine]:
        """Atomically claim idle machines via FOR UPDATE SKIP LOCKED.
        Returns machines that have been set to 'suspending' status."""
        result = await self.client.rpc(
            "claim_idle_machines",
            {"idle_threshold": threshold.isoformat(), "batch_size": batch_size},
        ).execute()
        return [UserMachine(**row) for row in (result.data or [])]

    async def get_monthly_llm_spend(self, user_id: str) -> int:
        """Returns current month's LLM spend in cents."""
        result = await self.client.rpc(
            "get_monthly_llm_spend", {"p_user_id": user_id}
        ).execute()
        return result.data or 0

    async def insert_usage_event(self, event: UsageEvent) -> None:
        await (
            self.client.table("usage_events")
            .insert(event.model_dump(exclude_none=True))
            .execute()
        )
```

**Step 2: Commit**

```bash
git add gateway/app/services/
git commit -m "feat: add Supabase service client"
```

---

### Task 5: Fly Machines API Client

**Files:**
- Create: `gateway/app/services/fly.py`
- Create: `gateway/tests/test_services/test_fly.py`

**Step 1: Write the test**

```python
# gateway/tests/test_services/test_fly.py
import pytest
from unittest.mock import AsyncMock, patch
from app.services.fly import FlyClient


@pytest.fixture
def fly():
    return FlyClient(token="test-token", org="test-org")


class TestFlyClient:
    async def test_create_app(self, fly):
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": "app-123", "name": "magister-user-abc"}
        mock_response.is_success = True

        with patch.object(fly._client, "post", return_value=mock_response) as mock_post:
            result = await fly.create_app("magister-user-abc")
            mock_post.assert_called_once()
            assert result["name"] == "magister-user-abc"

    async def test_suspend_machine(self, fly):
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {}
        mock_response.is_success = True

        with patch.object(fly._client, "post", return_value=mock_response) as mock_post:
            await fly.suspend_machine("magister-user-abc", "machine-123")
            call_url = mock_post.call_args[0][0]
            assert "machine-123/suspend" in call_url

    async def test_raises_on_error(self, fly):
        mock_response = AsyncMock()
        mock_response.status_code = 404
        mock_response.text = "Not found"
        mock_response.is_success = False

        with patch.object(fly._client, "post", return_value=mock_response):
            with pytest.raises(Exception, match="Fly API error 404"):
                await fly.create_app("bad-app")
```

**Step 2: Write the implementation**

```python
# gateway/app/services/fly.py
import asyncio
import httpx

FLY_API_BASE = "https://api.machines.dev/v1"
FLY_GRAPHQL_URL = "https://api.fly.io/graphql"


class FlyClient:
    def __init__(self, token: str, org: str):
        self._token = token
        self._org = org
        self._client = httpx.AsyncClient(
            base_url=FLY_API_BASE,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def _request(self, method: str, path: str, retries: int = 3, **kwargs) -> dict:
        """Make a Fly API request with retry logic for transient failures."""
        last_error = None
        for attempt in range(retries):
            try:
                response = await self._client.request(method, path, **kwargs)
                if response.is_success:
                    return response.json()
                if response.status_code >= 500 and attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt)  # exponential backoff
                    continue
                raise Exception(f"Fly API error {response.status_code}: {response.text}")
            except httpx.TimeoutException as e:
                last_error = e
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise Exception(f"Fly API timeout after {retries} attempts") from e
        raise last_error  # should not reach here

    # --- Apps ---

    async def create_app(self, app_name: str) -> dict:
        return await self._request(
            "POST", "/apps",
            json={"app_name": app_name, "org_slug": self._org},
        )

    async def delete_app(self, app_name: str) -> None:
        await self._request("DELETE", f"/apps/{app_name}")

    # --- Secrets (Fly GraphQL API) ---

    async def set_secrets(self, app_name: str, secrets: dict[str, str]) -> None:
        secret_input = [{"key": k, "value": v} for k, v in secrets.items()]
        mutation = """
            mutation($input: SetSecretsInput!) {
                setSecrets(input: $input) { app { name } }
            }
        """
        async with httpx.AsyncClient() as client:
            response = await client.post(
                FLY_GRAPHQL_URL,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                },
                json={
                    "query": mutation,
                    "variables": {"input": {"appId": app_name, "secrets": secret_input}},
                },
            )
            if not response.is_success:
                raise Exception(f"Fly GraphQL error {response.status_code}: {response.text}")
            result = response.json()
            if result.get("errors"):
                raise Exception(f"Fly setSecrets failed: {result['errors'][0]['message']}")

    # --- Volumes ---

    async def create_volume(self, app_name: str, name: str, size_gb: int, region: str) -> dict:
        return await self._request(
            "POST", f"/apps/{app_name}/volumes",
            json={"name": name, "size_gb": size_gb, "region": region},
        )

    async def delete_volume(self, app_name: str, volume_id: str) -> None:
        await self._request("DELETE", f"/apps/{app_name}/volumes/{volume_id}")

    # --- Machines ---

    async def create_machine(self, app_name: str, config: dict) -> dict:
        return await self._request("POST", f"/apps/{app_name}/machines", json=config)

    async def get_machine(self, app_name: str, machine_id: str) -> dict:
        return await self._request("GET", f"/apps/{app_name}/machines/{machine_id}")

    async def start_machine(self, app_name: str, machine_id: str) -> None:
        await self._request("POST", f"/apps/{app_name}/machines/{machine_id}/start")

    async def stop_machine(self, app_name: str, machine_id: str) -> None:
        await self._request("POST", f"/apps/{app_name}/machines/{machine_id}/stop")

    async def suspend_machine(self, app_name: str, machine_id: str) -> None:
        await self._request("POST", f"/apps/{app_name}/machines/{machine_id}/suspend")

    async def delete_machine(self, app_name: str, machine_id: str) -> None:
        await self._request("DELETE", f"/apps/{app_name}/machines/{machine_id}")

    async def wait_for_state(
        self, app_name: str, machine_id: str, state: str, timeout_s: int = 30
    ) -> None:
        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            machine = await self.get_machine(app_name, machine_id)
            if machine.get("state") == state:
                return
            await asyncio.sleep(1)
        raise TimeoutError(
            f"Machine {machine_id} did not reach state '{state}' within {timeout_s}s"
        )

    async def close(self):
        await self._client.aclose()
```

**Step 3: Run tests**

```bash
cd gateway && python -m pytest tests/test_services/test_fly.py -v
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add gateway/app/services/fly.py gateway/tests/test_services/test_fly.py
git commit -m "feat: add Fly Machines API client"
```

---

### Task 6: LLM Service (litellm + Budget Enforcement)

**Files:**
- Create: `gateway/app/services/llm.py`
- Create: `gateway/tests/test_services/test_llm.py`

**Step 1: Write the test**

```python
# gateway/tests/test_services/test_llm.py
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from app.services.llm import LLMService


@pytest.fixture
def llm_service():
    mock_supabase = AsyncMock()
    return LLMService(
        anthropic_api_key="sk-test",
        supabase=mock_supabase,
        plan_budgets={"cmo": 5000, "cmo_plus": 15000},
        plan_allowed_models={
            "cmo": ["claude-sonnet-4-6", "claude-haiku-4-5"],
            "cmo_plus": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
        },
    )


class TestLLMService:
    async def test_check_budget_within_limit(self, llm_service):
        llm_service._supabase.get_monthly_llm_spend = AsyncMock(return_value=2000)
        result = await llm_service.check_budget("user-123", "cmo")
        assert result is True

    async def test_check_budget_exceeded(self, llm_service):
        llm_service._supabase.get_monthly_llm_spend = AsyncMock(return_value=5500)
        result = await llm_service.check_budget("user-123", "cmo")
        assert result is False

    async def test_validate_model_allowed_for_plan(self, llm_service):
        assert llm_service.validate_model("claude-sonnet-4-6", "cmo") is True

    async def test_validate_model_blocked_for_plan(self, llm_service):
        """CMO users cannot access Opus."""
        assert llm_service.validate_model("claude-opus-4-6", "cmo") is False

    async def test_validate_model_opus_allowed_for_cmo_plus(self, llm_service):
        assert llm_service.validate_model("claude-opus-4-6", "cmo_plus") is True

    async def test_validate_model_unknown_blocked(self, llm_service):
        assert llm_service.validate_model("gpt-4o", "cmo") is False
```

**Step 2: Write the implementation**

```python
# gateway/app/services/llm.py
import math
import time
import logging
from typing import AsyncGenerator

import litellm

from app.models import UsageEvent
from app.services.supabase_client import SupabaseService

logger = logging.getLogger(__name__)

# Cost per 1M tokens in cents (approximate, update as pricing changes)
MODEL_COSTS = {
    "claude-sonnet-4-6": {"input": 300, "output": 1500},       # $3/$15 per 1M
    "claude-haiku-4-5": {"input": 80, "output": 400},           # $0.80/$4 per 1M
    "claude-opus-4-6": {"input": 1500, "output": 7500},         # $15/$75 per 1M
}


class LLMService:
    def __init__(
        self,
        anthropic_api_key: str,
        supabase: SupabaseService,
        plan_budgets: dict[str, int],
        plan_allowed_models: dict[str, list[str]],
    ):
        self._api_key = anthropic_api_key
        self._supabase = supabase
        self._plan_budgets = plan_budgets
        self._plan_allowed_models = plan_allowed_models  # keyed by plan name

        # In-memory spend cache: {user_id: (spend_cents, timestamp)}
        self._spend_cache: dict[str, tuple[int, float]] = {}
        self._cache_ttl = 30  # seconds

    def validate_model(self, model: str, plan: str) -> bool:
        """Check if model is allowed for the user's plan."""
        allowed = self._plan_allowed_models.get(plan, [])
        return model in allowed

    async def check_budget(self, user_id: str, plan: str) -> bool:
        budget_cents = self._plan_budgets.get(plan, 5000)
        spend = await self._get_cached_spend(user_id)
        return spend < budget_cents

    async def _get_cached_spend(self, user_id: str) -> int:
        cached = self._spend_cache.get(user_id)
        if cached and (time.time() - cached[1]) < self._cache_ttl:
            return cached[0]

        spend = await self._supabase.get_monthly_llm_spend(user_id)
        self._spend_cache[user_id] = (spend, time.time())
        return spend

    def _invalidate_cache(self, user_id: str) -> None:
        self._spend_cache.pop(user_id, None)

    async def completion(
        self,
        model: str,
        messages: list[dict],
        user_id: str,
        stream: bool = False,
        **kwargs,
    ) -> dict | AsyncGenerator:
        """Call litellm with Magister's API key. Returns response or async generator."""
        litellm_kwargs = {
            "model": f"anthropic/{model}",
            "messages": messages,
            "api_key": self._api_key,
            "stream": stream,
            **kwargs,
        }

        # For streaming: request usage stats in the final chunk so we can
        # count tokens. Without this, streaming responses report zero usage.
        if stream:
            litellm_kwargs["stream_options"] = {"include_usage": True}
            return self._stream_completion(litellm_kwargs, user_id, model)
        else:
            response = await litellm.acompletion(**litellm_kwargs)
            await self._record_usage(user_id, model, response)
            return response

    async def _stream_completion(
        self, kwargs: dict, user_id: str, model: str
    ) -> AsyncGenerator:
        response = await litellm.acompletion(**kwargs)
        total_input_tokens = 0
        total_output_tokens = 0

        async for chunk in response:
            yield chunk
            # Accumulate token counts from stream (final chunk includes usage)
            usage = getattr(chunk, "usage", None)
            if usage:
                total_input_tokens = getattr(usage, "prompt_tokens", 0) or total_input_tokens
                total_output_tokens = getattr(usage, "completion_tokens", 0) or total_output_tokens

        # Record usage after stream completes
        if total_input_tokens or total_output_tokens:
            cost_cents = self._calculate_cost(model, total_input_tokens, total_output_tokens)
            await self._supabase.insert_usage_event(UsageEvent(
                user_id=user_id,
                event_type="llm_request",
                model=model,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                cost_cents=cost_cents,
            ))
            self._invalidate_cache(user_id)

    async def _record_usage(self, user_id: str, model: str, response) -> None:
        usage = getattr(response, "usage", None)
        if not usage:
            return

        input_tokens = getattr(usage, "prompt_tokens", 0)
        output_tokens = getattr(usage, "completion_tokens", 0)
        cost_cents = self._calculate_cost(model, input_tokens, output_tokens)

        await self._supabase.insert_usage_event(UsageEvent(
            user_id=user_id,
            event_type="llm_request",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_cents=cost_cents,
        ))
        self._invalidate_cache(user_id)

    @staticmethod
    def _calculate_cost(model: str, input_tokens: int, output_tokens: int) -> int:
        """Calculate cost in cents, rounding UP to avoid recording $0 for small requests."""
        costs = MODEL_COSTS.get(model, {"input": 300, "output": 1500})
        input_cost = (input_tokens / 1_000_000) * costs["input"]
        output_cost = (output_tokens / 1_000_000) * costs["output"]
        return max(1, math.ceil(input_cost + output_cost))
```

**Step 3: Run tests**

```bash
cd gateway && python -m pytest tests/test_services/test_llm.py -v
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add gateway/app/services/llm.py gateway/tests/test_services/test_llm.py
git commit -m "feat: add LLM service with litellm + budget enforcement"
```

---

## Phase 3: Middleware & Routes

### Task 7: Auth Dependencies (JWT + Machine Token)

**Files:**
- Create: `gateway/app/middleware/auth.py`
- Create: `gateway/tests/test_middleware/test_auth.py`

**Step 1: Write the test**

```python
# gateway/tests/test_middleware/test_auth.py
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.middleware.auth import create_jwt_dependency


def test_rejects_missing_auth():
    app = FastAPI()
    verify_jwt = create_jwt_dependency("test-secret")

    @app.get("/test")
    async def test_route(user_id: str = verify_jwt):
        return {"user_id": user_id}

    client = TestClient(app)
    response = client.get("/test")
    assert response.status_code == 401


def test_rejects_invalid_token():
    app = FastAPI()
    verify_jwt = create_jwt_dependency("test-secret")

    @app.get("/test")
    async def test_route(user_id: str = verify_jwt):
        return {"user_id": user_id}

    client = TestClient(app)
    response = client.get("/test", headers={"Authorization": "Bearer bad-token"})
    assert response.status_code == 401
```

**Step 2: Write the implementation**

```python
# gateway/app/middleware/auth.py
import hashlib
from fastapi import Depends, HTTPException, Request
from jose import jwt, JWTError


def create_jwt_dependency(jwt_secret: str):
    """FastAPI dependency that verifies Supabase JWT and returns user_id."""

    async def verify_jwt(request: Request) -> str:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

        token = auth_header[7:]
        try:
            payload = jwt.decode(token, jwt_secret, algorithms=["HS256"])
            user_id = payload.get("sub")
            if not user_id:
                raise HTTPException(status_code=401, detail="Invalid token: no user_id")
            return user_id
        except JWTError:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

    return Depends(verify_jwt)


def hash_token(token: str) -> str:
    """SHA-256 hash a bearer token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()


async def verify_machine_token(request: Request) -> str:
    """FastAPI dependency that verifies per-machine bearer token.
    Returns the token hash (used to look up the user machine).
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = auth_header[7:]
    return hash_token(token)
```

**Step 3: Run tests**

```bash
cd gateway && python -m pytest tests/test_middleware/test_auth.py -v
```

Expected: PASS.

**Step 4: Commit**

```bash
git add gateway/app/middleware/ gateway/tests/test_middleware/
git commit -m "feat: add JWT and machine token auth dependencies"
```

---

### Task 8: Rate Limiting Middleware

**Files:**
- Create: `gateway/app/middleware/rate_limit.py`

**Step 1: Write the implementation**

```python
# gateway/app/middleware/rate_limit.py
import time
from fastapi import HTTPException, Request


class RateLimiter:
    """In-memory token bucket rate limiter keyed by user_id."""

    def __init__(self, max_requests: int, window_seconds: float):
        self._max = max_requests
        self._window = window_seconds
        self._buckets: dict[str, dict] = {}

    def check(self, user_id: str) -> None:
        now = time.time()
        bucket = self._buckets.get(user_id)

        if not bucket:
            bucket = {"tokens": self._max, "last_refill": now}
            self._buckets[user_id] = bucket

        # Refill
        elapsed = now - bucket["last_refill"]
        refill = int((elapsed / self._window) * self._max)
        if refill > 0:
            bucket["tokens"] = min(self._max, bucket["tokens"] + refill)
            bucket["last_refill"] = now

        if bucket["tokens"] <= 0:
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again shortly.")

        bucket["tokens"] -= 1

    def cleanup(self) -> None:
        """Remove stale buckets. Call periodically."""
        now = time.time()
        stale = [k for k, v in self._buckets.items() if now - v["last_refill"] > self._window * 2]
        for k in stale:
            del self._buckets[k]
```

**Step 2: Commit**

```bash
git add gateway/app/middleware/rate_limit.py
git commit -m "feat: add per-user rate limiting"
```

---

### Task 9: Provision Route

**Files:**
- Create: `gateway/app/routes/provision.py`

**Step 1: Write the implementation**

```python
# gateway/app/routes/provision.py
import secrets
import logging
from fastapi import APIRouter, HTTPException

from app.models import ProvisionRequest
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService
from app.middleware.auth import hash_token
from app.config import Settings

logger = logging.getLogger(__name__)
router = APIRouter()


def create_provision_router(fly: FlyClient, supabase: SupabaseService, settings: Settings):
    @router.post("/provision")
    async def provision(req: ProvisionRequest, user_id: str):
        # Check if user already has a machine
        existing = await supabase.get_user_machine(req.user_id)
        if existing and existing.status != "failed":
            raise HTTPException(409, "User already has a machine")

        fly_app_name = f"magister-{req.user_id.replace('-', '')[:20]}"
        fly_region = req.region or settings.default_region

        record = existing
        step = record.provisioning_step if record else 0

        try:
            # Step 1: Create DB record
            if step < 1:
                record = await supabase.create_user_machine({
                    "user_id": req.user_id,
                    "fly_app_name": fly_app_name,
                    "fly_region": fly_region,
                    "plan": req.plan,
                    "status": "provisioning",
                    "provisioning_step": 1,
                })
                step = 1

            record_id = record.id

            # Step 2: Create Fly App
            if step < 2:
                await fly.create_app(fly_app_name)
                await supabase.update_user_machine(record_id, provisioning_step=2)
                step = 2

            # Step 3: Generate token + set Fly secrets (combined to prevent token loss)
            # On retry: if gateway_token is already set, reuse it instead of generating new
            if step < 3:
                if record and record.gateway_token:
                    # Retry case: reuse the token already stored in Supabase
                    machine_token = record.gateway_token
                else:
                    machine_token = secrets.token_urlsafe(32)

                token_hash = hash_token(machine_token)

                # Store both plaintext (for chat forwarding) and hash (for LLM auth lookup)
                await supabase.update_user_machine(
                    record_id,
                    gateway_token=machine_token,
                    gateway_token_hash=token_hash,
                )

                # Set Fly secrets on user app (does NOT restart the Gateway)
                await fly.set_secrets(fly_app_name, {
                    "MACHINE_AUTH_TOKEN": machine_token,
                    "LLM_BASE_URL": "http://magister-gateway.internal:8080/llm/v1",
                })

                await supabase.update_user_machine(record_id, provisioning_step=3)
                step = 3

            # Step 4: Create Volume
            volume_id = None
            if step < 4:
                vol = await fly.create_volume(fly_app_name, "openclaw_data", 5, fly_region)
                volume_id = vol["id"]
                await supabase.update_user_machine(
                    record_id, fly_volume_id=volume_id, provisioning_step=4,
                )
                step = 4

            # Step 5: Create Machine
            if step < 5:
                if not volume_id:
                    volume_id = record.fly_volume_id

                machine = await fly.create_machine(fly_app_name, {
                    "config": {
                        "image": settings.openclaw_image,
                        "guest": {"cpus": 2, "memory_mb": 2048, "cpu_kind": "shared"},
                        "env": {
                            "OPENCLAW_HOME": "/data/.openclaw",
                            "OPENCLAW_USER_ID": req.user_id,
                        },
                        "mounts": [{"volume": volume_id, "path": "/data"}],
                        "services": [{
                            "ports": [{"port": 443, "handlers": ["tls", "http"]}],
                            "internal_port": 18789,
                            "protocol": "tcp",
                        }],
                        "auto_destroy": False,
                        "restart": {"policy": "on-failure"},
                    },
                })
                await supabase.update_user_machine(
                    record_id, fly_machine_id=machine["id"], provisioning_step=5,
                )
                step = 5

            # Step 6: Wait for machine to start
            if step < 6:
                await fly.wait_for_state(
                    fly_app_name, record.fly_machine_id or machine["id"], "started", 60,
                )
                await supabase.update_user_machine(
                    record_id,
                    status="running",
                    current_image=settings.openclaw_image,
                    provisioning_step=6,
                )

            return {"status": "provisioned", "fly_app_name": fly_app_name}

        except Exception as e:
            if record:
                await supabase.update_user_machine(record.id, status="failed")
            logger.error(f"Provision failed for {req.user_id} at step {step}: {e}")
            raise HTTPException(500, f"Provisioning failed at step {step}")

    return router
```

**Step 2: Commit**

```bash
git add gateway/app/routes/provision.py
git commit -m "feat: add provisioning route with idempotent step tracking"
```

---

### Task 10: Chat Route (SSE Proxy)

**Files:**
- Create: `gateway/app/routes/chat.py`

**Step 1: Write the implementation**

```python
# gateway/app/routes/chat.py
import time
import logging
import httpx
from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.models import ChatRequest
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger(__name__)
router = APIRouter()

# Track active requests per user (concurrency lock).
# NOTE: This is per-Gateway-instance. With 2 instances behind a load balancer,
# a user could theoretically have 2 concurrent chats. Acceptable for early
# access; upgrade to Supabase-backed lock if needed (see Open Questions).
active_requests: set[str] = set()

# Debounce last_activity updates: at most once per 30s per user
# Prevents 100-500 DB writes per response (one per SSE chunk)
_last_activity_timestamps: dict[str, float] = {}
ACTIVITY_DEBOUNCE_SECONDS = 30


async def _debounced_update_last_activity(supabase: SupabaseService, user_id: str):
    now = time.time()
    last = _last_activity_timestamps.get(user_id, 0)
    if now - last >= ACTIVITY_DEBOUNCE_SECONDS:
        await supabase.update_last_activity(user_id)
        _last_activity_timestamps[user_id] = now


def create_chat_router(fly: FlyClient, supabase: SupabaseService):
    @router.post("/chat")
    async def chat(req: ChatRequest, user_id: str):
        if user_id in active_requests:
            raise HTTPException(409, "Your agent is still working on the previous task.")

        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(404, "No agent found. Please contact support.")

        if machine.status in ("destroyed", "destroying"):
            raise HTTPException(410, "Agent has been deactivated.")
        if machine.status == "provisioning":
            raise HTTPException(503, "Agent is still being set up. Try again in a minute.")
        if machine.status == "failed":
            raise HTTPException(500, "Agent setup failed. Please contact support.")

        # Wake machine if suspended
        if machine.status == "suspended":
            try:
                await fly.start_machine(machine.fly_app_name, machine.fly_machine_id)
                await fly.wait_for_state(
                    machine.fly_app_name, machine.fly_machine_id, "started", 30,
                )
                await supabase.update_user_machine(machine.id, status="running")
            except Exception as e:
                logger.error(f"Failed to wake machine for {user_id}: {e}")
                raise HTTPException(503, "Failed to wake your agent. Please try again.")

        # Health check
        machine_url = (
            f"http://{machine.fly_machine_id}.vm.{machine.fly_app_name}.internal:18789"
        )
        async with httpx.AsyncClient(timeout=5.0) as client:
            try:
                resp = await client.get(f"{machine_url}/health")
                if resp.status_code != 200:
                    raise Exception("Health check failed")
            except Exception:
                raise HTTPException(503, "Agent is starting up. Please try again in a few seconds.")

        active_requests.add(user_id)
        await supabase.update_last_activity(user_id)

        # Get machine token from Supabase (stored as plaintext in gateway_token column)
        # instead of from env vars (which would require Gateway restart on every provision)
        machine_token = machine.gateway_token

        async def event_generator():
            try:
                async with httpx.AsyncClient(timeout=300.0) as client:
                    async with client.stream(
                        "POST",
                        f"{machine_url}/api/chat",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {machine_token}",
                        },
                        json={"message": req.message, "session_id": req.session_id},
                    ) as response:
                        if response.status_code != 200:
                            yield {"event": "error", "data": '{"error": "Agent returned an error."}'}
                            return

                        async for chunk in response.aiter_text():
                            yield {"event": "chunk", "data": chunk}
                            # Debounced — updates at most once per 30s, not per chunk
                            await _debounced_update_last_activity(supabase, user_id)

                yield {"event": "done", "data": "{}"}
            except Exception as e:
                logger.error(f"Chat stream error for {user_id}: {e}")
                yield {"event": "error", "data": '{"error": "Connection to agent lost."}'}
            finally:
                active_requests.discard(user_id)
                # Always update on stream end so idle sweep has accurate timestamp
                await supabase.update_last_activity(user_id)

        return EventSourceResponse(event_generator())

    return router
```

**Step 2: Commit**

```bash
git add gateway/app/routes/chat.py
git commit -m "feat: add chat route with SSE streaming and concurrency lock"
```

---

### Task 11: LLM Proxy Route (OpenAI-Compatible)

**Files:**
- Create: `gateway/app/routes/llm_proxy.py`

**Step 1: Write the implementation**

```python
# gateway/app/routes/llm_proxy.py
import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.models import LLMCompletionRequest
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService
from app.middleware.auth import verify_machine_token

logger = logging.getLogger(__name__)
router = APIRouter()


def create_llm_proxy_router(llm: LLMService, supabase: SupabaseService):
    @router.post("/v1/chat/completions")
    async def chat_completions(
        req: LLMCompletionRequest,
        token_hash: str = Depends(verify_machine_token),
    ):
        # Look up user machine by token hash
        machine = await supabase.get_user_machine_by_token_hash(token_hash)
        if not machine:
            raise HTTPException(401, "Invalid machine token")

        user_id = machine.user_id
        plan = machine.plan

        # Validate model against the user's plan allowlist
        if not llm.validate_model(req.model, plan):
            raise HTTPException(
                400, f"Model '{req.model}' is not available on the {plan} plan."
            )

        # Check budget
        within_budget = await llm.check_budget(user_id, plan)
        if not within_budget:
            raise HTTPException(
                429,
                "Monthly LLM usage limit reached. Your agent's budget resets next month.",
            )

        if req.stream:
            async def stream_generator():
                try:
                    gen = await llm.completion(
                        model=req.model,
                        messages=req.messages,
                        user_id=user_id,
                        stream=True,
                        temperature=req.temperature,
                        max_tokens=req.max_tokens,
                    )
                    async for chunk in gen:
                        chunk_data = chunk.model_dump_json() if hasattr(chunk, "model_dump_json") else json.dumps(chunk)
                        yield {"data": chunk_data}
                    yield {"data": "[DONE]"}
                except Exception as e:
                    logger.error(f"LLM stream error for {user_id}: {e}")
                    yield {"data": json.dumps({"error": str(e)})}

            return EventSourceResponse(stream_generator())
        else:
            try:
                response = await llm.completion(
                    model=req.model,
                    messages=req.messages,
                    user_id=user_id,
                    stream=False,
                    temperature=req.temperature,
                    max_tokens=req.max_tokens,
                )
                return response.model_dump() if hasattr(response, "model_dump") else response
            except Exception as e:
                logger.error(f"LLM error for {user_id}: {e}")
                raise HTTPException(500, f"LLM request failed: {str(e)}")

    return router
```

**Step 2: Commit**

```bash
git add gateway/app/routes/llm_proxy.py
git commit -m "feat: add OpenAI-compatible LLM proxy route with budget enforcement"
```

---

### Task 12: Destroy, Status, and Health Routes

**Files:**
- Create: `gateway/app/routes/destroy.py`
- Create: `gateway/app/routes/status.py`
- Create: `gateway/app/routes/health.py`

**Step 1: Write destroy route**

```python
# gateway/app/routes/destroy.py
import logging
from fastapi import APIRouter, HTTPException

from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger(__name__)
router = APIRouter()


def create_destroy_router(fly: FlyClient, supabase: SupabaseService):
    @router.post("/destroy")
    async def destroy(user_id: str):
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(404, "No machine found")

        await supabase.update_user_machine(machine.id, status="destroying")

        try:
            if machine.fly_machine_id:
                try:
                    await fly.stop_machine(machine.fly_app_name, machine.fly_machine_id)
                except Exception:
                    pass
                try:
                    await fly.delete_machine(machine.fly_app_name, machine.fly_machine_id)
                except Exception as e:
                    logger.error(f"Failed to delete machine: {e}")

            if machine.fly_volume_id:
                try:
                    await fly.delete_volume(machine.fly_app_name, machine.fly_volume_id)
                except Exception as e:
                    logger.error(f"Failed to delete volume: {e}")

            try:
                await fly.delete_app(machine.fly_app_name)
            except Exception as e:
                logger.error(f"Failed to delete app: {e}")

            await supabase.update_user_machine(machine.id, status="destroyed")
            return {"status": "destroyed"}

        except Exception as e:
            logger.error(f"Destroy failed for {user_id}: {e}")
            raise HTTPException(500, f"Teardown partially failed: {e}")

    return router
```

**Step 2: Write status route**

```python
# gateway/app/routes/status.py
from fastapi import APIRouter, HTTPException

from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

router = APIRouter()


def create_status_router(fly: FlyClient, supabase: SupabaseService):
    @router.get("/status")
    async def status(user_id: str):
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(404, "No agent found")

        fly_state = None
        if machine.fly_machine_id:
            try:
                m = await fly.get_machine(machine.fly_app_name, machine.fly_machine_id)
                fly_state = m.get("state")
            except Exception:
                fly_state = "unknown"

        spend_cents = await supabase.get_monthly_llm_spend(machine.user_id)

        return {
            "status": machine.status,
            "fly_state": fly_state,
            "region": machine.fly_region,
            "last_activity": machine.last_activity,
            "plan": machine.plan,
            "llm_spend_cents": spend_cents,
        }

    return router
```

**Step 3: Write health route**

```python
# gateway/app/routes/health.py
from datetime import datetime, timezone
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
```

**Step 4: Commit**

```bash
git add gateway/app/routes/destroy.py gateway/app/routes/status.py gateway/app/routes/health.py
git commit -m "feat: add destroy, status, and health routes"
```

---

### Task 13: Idle Sweep Background Job

**Files:**
- Create: `gateway/app/jobs/idle_sweep.py`

**Step 1: Write the implementation**

```python
# gateway/app/jobs/idle_sweep.py
import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx

from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger(__name__)

IDLE_THRESHOLD_MINUTES = 10
SWEEP_INTERVAL_SECONDS = 120


async def start_idle_sweep(fly: FlyClient, supabase: SupabaseService) -> asyncio.Task:
    """Start the idle sweep as a background asyncio task."""

    async def loop():
        logger.info(
            f"[idle-sweep] Starting with {IDLE_THRESHOLD_MINUTES}min threshold, "
            f"{SWEEP_INTERVAL_SECONDS}s interval"
        )
        while True:
            try:
                await sweep(fly, supabase)
            except Exception as e:
                logger.error(f"[idle-sweep] Error: {e}")
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)

    return asyncio.create_task(loop())


async def sweep(fly: FlyClient, supabase: SupabaseService) -> None:
    """Claim and suspend idle machines.

    Uses FOR UPDATE SKIP LOCKED (via claim_idle_machines) so multiple Gateway
    instances can run this concurrently — each claims a different batch of
    machines without duplicating work. No advisory locks needed.
    """
    threshold = datetime.now(timezone.utc) - timedelta(minutes=IDLE_THRESHOLD_MINUTES)
    claimed = await supabase.claim_idle_machines(threshold, batch_size=10)
    if not claimed:
        return

    logger.info(f"[idle-sweep] Claimed {len(claimed)} idle machines")

    for machine in claimed:
        if not machine.fly_machine_id:
            # Reset status back to running if no machine ID
            await supabase.update_user_machine(machine.id, status="running")
            continue

        # Check heartbeat — machine may be working silently
        try:
            url = (
                f"http://{machine.fly_machine_id}.vm."
                f"{machine.fly_app_name}.internal:18789/health"
            )
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("active"):
                        logger.info(f"[idle-sweep] {machine.fly_app_name} is active, skipping")
                        await supabase.update_user_machine(machine.id, status="running")
                        await supabase.update_last_activity(machine.user_id)
                        continue
        except Exception:
            pass  # Machine unreachable — proceed with suspend

        try:
            logger.info(f"[idle-sweep] Suspending {machine.fly_app_name}")
            await fly.suspend_machine(machine.fly_app_name, machine.fly_machine_id)
            await supabase.update_user_machine(machine.id, status="suspended")
        except Exception as e:
            logger.error(f"[idle-sweep] Failed to suspend {machine.fly_app_name}: {e}")
            # Reset to running so it gets picked up in the next sweep
            await supabase.update_user_machine(machine.id, status="running")
```

**Step 2: Commit**

```bash
git add gateway/app/jobs/
git commit -m "feat: add idle sweep background job with advisory locking"
```

---

### Task 14: Gateway Entry Point — Wire Everything Together

**Files:**
- Create: `gateway/app/main.py`

**Step 1: Write the implementation**

```python
# gateway/app/main.py
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.services.fly import FlyClient
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService
from app.middleware.auth import create_jwt_dependency
from app.middleware.rate_limit import RateLimiter
from app.routes.health import router as health_router
from app.routes.chat import create_chat_router
from app.routes.provision import create_provision_router
from app.routes.destroy import create_destroy_router
from app.routes.status import create_status_router
from app.routes.llm_proxy import create_llm_proxy_router
from app.jobs.idle_sweep import start_idle_sweep

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Settings can be loaded at module level (reads env vars, no I/O)
settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize all services inside the lifespan context (not at module level).
    This ensures async services (like Supabase) are created within an event loop,
    and all services are properly cleaned up on shutdown."""
    logger.info(f"Gateway starting on port {settings.port}")

    # Initialize services (Supabase requires async factory)
    supabase = await SupabaseService.create(
        settings.supabase_url, settings.supabase_service_role_key
    )
    fly = FlyClient(settings.fly_api_token, settings.fly_org)
    llm = LLMService(
        anthropic_api_key=settings.anthropic_api_key,
        supabase=supabase,
        plan_budgets=settings.plan_budgets,
        plan_allowed_models=settings.plan_allowed_models,
    )

    # Store services on app.state so routes can access them
    app.state.supabase = supabase
    app.state.fly = fly
    app.state.llm = llm
    app.state.settings = settings

    # Wire up routes (pass service instances)
    app.include_router(health_router)
    app.include_router(create_llm_proxy_router(llm, supabase), prefix="/llm")
    app.include_router(create_chat_router(fly, supabase), prefix="/api")
    app.include_router(create_provision_router(fly, supabase, settings), prefix="/api")
    app.include_router(create_destroy_router(fly, supabase), prefix="/api")
    app.include_router(create_status_router(fly, supabase), prefix="/api")

    # Start background jobs
    idle_sweep_task = await start_idle_sweep(fly, supabase)

    yield

    # Shutdown
    logger.info("Gateway shutting down")
    idle_sweep_task.cancel()
    await fly.close()


app = FastAPI(lifespan=lifespan)

# CORS (middleware added at module level — doesn't need async services)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
```

**Step 2: Verify it runs locally**

```bash
cd gateway && python -m app.main
```

Expected: FastAPI starts (will fail without env vars, but should import cleanly).

**Step 3: Commit**

```bash
git add gateway/app/main.py
git commit -m "feat: wire up FastAPI gateway with all routes and background jobs"
```

---

## Phase 4: OpenClaw Docker Image

### Task 15: Create OpenClaw Docker Image + Entrypoint

**Files:**
- Create: `openclaw-image/Dockerfile`
- Create: `openclaw-image/entrypoint.sh`
- Create: `openclaw-image/default-config/openclaw.json`

**Step 1: Write the Dockerfile**

```dockerfile
# openclaw-image/Dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
    chromium git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY openclaw/ /app/openclaw/
RUN cd /app/openclaw && corepack enable && pnpm install --frozen-lockfile && pnpm build

COPY default-config/ /app/default-config/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789
ENTRYPOINT ["/entrypoint.sh"]
```

**Step 2: Write the entrypoint script**

```bash
#!/bin/bash
# openclaw-image/entrypoint.sh
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"

# First boot: initialize config from defaults
if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
    echo "[entrypoint] First boot — initializing OpenClaw home at $OPENCLAW_HOME"
    mkdir -p "$OPENCLAW_HOME/credentials"
    mkdir -p "$OPENCLAW_HOME/workspace"
    mkdir -p "$OPENCLAW_HOME/agents"
    cp -r /app/default-config/* "$OPENCLAW_HOME/"
fi

# Inject/refresh LLM config from env vars (set via Fly secrets)
# MACHINE_AUTH_TOKEN is used as the API key for the Gateway's LLM proxy
# LLM_BASE_URL points to the Gateway's /llm/v1 endpoint
if [ -n "$MACHINE_AUTH_TOKEN" ]; then
    mkdir -p "$OPENCLAW_HOME/credentials"
    cat > "$OPENCLAW_HOME/credentials/llm-keys.json" <<EOF
{
  "anthropic": {
    "apiKey": "${MACHINE_AUTH_TOKEN}",
    "baseUrl": "${LLM_BASE_URL:-http://magister-gateway.internal:8080/llm/v1}"
  }
}
EOF
    echo "[entrypoint] LLM credentials refreshed (via gateway proxy)"
fi

echo "[entrypoint] Starting OpenClaw gateway on 0.0.0.0:18789"
exec node /app/openclaw/dist/index.js gateway \
    --home "$OPENCLAW_HOME" \
    --host 0.0.0.0 \
    --port 18789
```

**Step 3: Write default config**

```json
{
  "agents": {
    "list": [
      {
        "id": "marketing",
        "name": "Magister Marketing Agent",
        "workspace": "/data/.openclaw/workspace"
      }
    ],
    "defaults": {
      "maxConcurrent": 4,
      "sandbox": {
        "mode": "off"
      }
    }
  }
}
```

Note: Verify the exact OpenClaw config format against the OpenClaw codebase (`src/config/types.agents.ts`).

**Step 4: Commit**

```bash
git add openclaw-image/
git commit -m "feat: add OpenClaw Docker image with entrypoint and default config"
```

---

## Phase 5: Fly.io Deployment Configuration

### Task 16: Gateway fly.toml

Gateway Dockerfile already exists from Phase 1 Task 3 — same image runs locally and on Fly.io.

**Files:**
- Create: `gateway/fly.toml`

**Step 1: Write fly.toml**

```toml
# gateway/fly.toml
app = "magister-gateway"
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 30

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 2

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
```

**Step 2: Commit**

```bash
git add gateway/fly.toml
git commit -m "feat: add gateway Fly.io deployment config"
```

---

## Phase 6: CI/CD Workflows

### Task 17: GitHub Actions — Deploy Gateway

**Files:**
- Create: `.github/workflows/deploy-gateway.yml`

**Step 1: Write the workflow**

```yaml
# .github/workflows/deploy-gateway.yml
name: Deploy Gateway

on:
  push:
    branches: [main]
    paths:
      - 'gateway/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: gateway

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - run: pip install -r requirements.txt
      - run: python -m pytest tests/ -v

      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Step 2: Commit**

```bash
git add .github/workflows/deploy-gateway.yml
git commit -m "ci: add GitHub Actions workflow for gateway deployment"
```

---

### Task 18: GitHub Actions — Deploy OpenClaw Image

**Files:**
- Create: `.github/workflows/deploy-openclaw-image.yml`

**Step 1: Write the workflow**

```yaml
# .github/workflows/deploy-openclaw-image.yml
name: Deploy OpenClaw Image

on:
  push:
    branches: [main]
    paths:
      - 'openclaw-image/**'
  workflow_dispatch:

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: openclaw-image

    steps:
      - uses: actions/checkout@v4

      - run: git clone https://github.com/openclaw/openclaw.git openclaw
        # NOTE: pin to a specific tag/commit for reproducibility

      - uses: superfly/flyctl-actions/setup-flyctl@master

      - run: flyctl deploy --image-only --app magister-openclaw-registry
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Step 2: Commit**

```bash
git add .github/workflows/deploy-openclaw-image.yml
git commit -m "ci: add GitHub Actions workflow for OpenClaw image builds"
```

---

## Phase 7: Stripe Webhook Integration

### Task 19: Stripe Webhook Route (in webapp)

**Files:**
- Create: `webapp/src/app/api/billing/webhook/route.ts`

**Step 1: Write the implementation**

```typescript
// webapp/src/app/api/billing/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';

const GATEWAY_URL = process.env.GATEWAY_URL!;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id as string;
      const plan = (session.metadata as Record<string, string>)?.plan ?? 'cmo';

      const res = await fetch(`${GATEWAY_URL}/api/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId, plan }),
      });

      if (!res.ok) {
        console.error('Provisioning failed:', await res.text());
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const userId = (subscription.metadata as Record<string, string>)?.user_id;
      if (!userId) break;

      await fetch(`${GATEWAY_URL}/api/destroy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });
      break;
    }
  }

  return NextResponse.json({ received: true });
}
```

**Step 2: Commit**

```bash
git add webapp/src/app/api/billing/webhook/route.ts
git commit -m "feat: add Stripe webhook route for provisioning and teardown"
```

---

## Phase 8: First End-to-End Test

### Task 20: Manual E2E — Provision and Chat

This is a manual verification task. No code to write.

**Step 1: Set gateway secrets on Fly**

```bash
cd gateway
fly secrets set \
  FLY_API_TOKEN="..." \
  FLY_ORG="magister" \
  SUPABASE_URL="..." \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  SUPABASE_JWT_SECRET="..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  OPENCLAW_IMAGE="registry.fly.io/magister-openclaw-registry:latest"
```

**Step 2: Deploy gateway**

```bash
cd gateway && fly deploy
```

**Step 3: Test provisioning**

```bash
curl -X POST https://magister-gateway.fly.dev/api/provision \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<test-user-id>"}'
```

Expected: 200 response with `fly_app_name`.

**Step 4: Test chat**

```bash
curl -X POST https://magister-gateway.fly.dev/api/chat \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you help me with?"}'
```

Expected: SSE stream with agent response.

**Step 5: Verify idle suspend**

Wait 10+ minutes, then check machine status:

```bash
curl https://magister-gateway.fly.dev/api/status \
  -H "Authorization: Bearer <jwt>"
```

Expected: `status: "suspended"`.

**Step 6: Test wake-on-chat**

Send another chat message. Expected: brief delay (~300ms-2s), then response streams.

**Step 7: Test LLM budget enforcement**

```bash
# Verify spend tracking
curl https://magister-gateway.fly.dev/api/status \
  -H "Authorization: Bearer <jwt>"
```

Expected: `llm_spend_cents` shows accumulated usage.

---

---

## Pre-Launch Checklist (Before E2E Test)

These items are referenced in the design doc but not covered by the above tasks:

1. **Run Supabase migration on production** — Push the migration from Task 1 to your hosted Supabase project: `supabase db push --linked`
2. **Reconciliation job** — Add a background task (similar to idle sweep) that runs every 5 minutes to clean up `status = 'failed'` machines by retrying from their `provisioning_step` or tearing down partial resources
3. **Fly custom networks** — Investigate `fly network create` to isolate user machines from each other on the 6PN. Currently all apps in the same org share the network; bearer tokens are the only isolation. Decide whether this is acceptable for early access.

---

## Summary

| Phase | Tasks | Description |
|---|---|---|
| 1. Foundation | 1-3 | Supabase schema, Python project scaffold, Docker local dev (Gateway Dockerfile, docker-compose, seed data) |
| 2. Core Services | 4-6 | Supabase, Fly, LLM (litellm + budget) clients |
| 3. Middleware & Routes | 7-14 | Auth, rate limit, chat, LLM proxy, provision, destroy, idle sweep, entry point |
| 4. Docker Image | 15 | OpenClaw container for user machines |
| 5. Fly Config | 16 | Gateway fly.toml |
| 6. CI/CD | 17-18 | GitHub Actions for gateway + image deploys |
| 7. Stripe | 19 | Webhook route for provisioning/teardown |
| 8. E2E Test | 20 | Manual end-to-end verification |

**Total: 20 tasks, ~40-55 implementation steps**

Docker local dev is set up in Phase 1 so every subsequent phase can be tested locally with `make up`. The Gateway and user machine containers are the same images that run on Fly.io. Phases 1-3 are fully testable locally with real Anthropic API calls. Phases 4-7 require Fly.io account access for production deployment.

**Key differences from previous plan:**
- Gateway is Python/FastAPI instead of TypeScript/Hono
- LiteLLM is used as a library (`litellm.acompletion()`), not a separate Fly app
- No separate LiteLLM deployment phase — saves ~$24/mo and removes an entire service
- Budget enforcement via `usage_events` table with 30s in-memory cache
- Single Dockerfile, fly.toml, and CI workflow for the gateway
- User machines authenticate to gateway for both chat forwarding AND LLM calls using the same per-machine bearer token
