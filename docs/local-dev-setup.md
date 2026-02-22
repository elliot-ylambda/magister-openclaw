# Local Development Setup

Run the full backend stack locally: Supabase (Postgres) + Gateway (FastAPI) + User Machine (OpenClaw).

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker | 27+ | [docker.com](https://docs.docker.com/get-docker/) |
| Node.js | 22+ | `brew install node` |
| pnpm | 9+ | `corepack enable` |
| Python | 3.12+ | `brew install python@3.12` |
| Supabase CLI | latest | `brew install supabase/tap/supabase` |

## Steps

### 1. Start Local Supabase

```bash
make db-start
```

Boots Postgres (54322), API (54321), and Studio (54323). Note the keys printed on startup — you'll need **service_role key** and **JWT secret**.

To view keys again later:

```bash
cd webapp && pnpm supabase status
```

### 2. Reset the Database

```bash
make db-reset
```

Applies all migrations, then creates a dev auth user via the GoTrue admin API and seeds a dev machine row:

| What | Value |
|------|-------|
| Dev user email | `dev@magister.local` |
| Dev user password | `dev-password-not-for-production` |
| Dev user ID | `00000000-0000-0000-0000-000000000001` |
| Dev machine ID | `00000000-0000-0000-0000-000000000002` |
| Machine status | `running` |
| Gateway token | `dev-local-token-magister-2026` |

### 3. Create env files

```bash
make env
```

This copies the example templates. Then fill in `.env.docker` (gateway):

```env
# From `cd webapp && pnpm supabase status`
SUPABASE_URL=http://host.docker.internal:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
SUPABASE_JWT_SECRET=<from supabase status>

# Your Anthropic key (used by the LLM proxy)
ANTHROPIC_API_KEY=sk-ant-...

# Leave as-is for local dev
GATEWAY_API_KEY=dev-gateway-api-key-local-unsafe

# Point to locally built image (see step 4)
OPENCLAW_IMAGE=registry.fly.io/magister-openclaw:latest
```

`.env.machine.docker` (user-machine) works out of the box with defaults — no edits needed.

### 4. Build the OpenClaw Image

The docker-compose `user-machine` service pulls a pre-built image — it does not build from source. You must build the custom image locally first:

```bash
make image-build
```

This:
1. Copies `marketingskills/` into the Docker build context (`openclaw-image/skills/`)
2. Runs `docker build` which clones OpenClaw, installs Chromium, copies skills, and sets up the entrypoint

The build takes a few minutes the first time (Node 22 base + Chromium + OpenClaw `pnpm install`). Subsequent builds are faster due to Docker layer caching.

> **Quick alternative:** If you just want to test the gateway container without the full agent, you can skip this step and set `OPENCLAW_IMAGE=alpine/openclaw:latest` in `.env.docker`. Chat and LLM proxy won't work end-to-end, but the gateway will start.

### 5. Start the Stack

```bash
make up
```

Starts two containers:
- **gateway** on `localhost:8080` — FastAPI app
- **user-machine** on `localhost:18789` — OpenClaw agent

The user-machine waits for the gateway healthcheck to pass before starting.

Check logs:

```bash
make logs
```

## Testing with curl

### Health Check

```bash
curl http://localhost:8080/health
```

Expected:

```json
{"status": "ok", "version": "0.1.0", "timestamp": "..."}
```

### Provision (API Key Auth)

The seed script already created a running machine for the dev user, so this returns `already_running`:

```bash
curl -X POST http://localhost:8080/api/provision \
  -H "Authorization: Bearer dev-gateway-api-key-local-unsafe" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "00000000-0000-0000-0000-000000000001", "plan": "cmo"}'
```

Expected:

```json
{"status": "already_running", "machine_id": "00000000-0000-0000-0000-000000000002"}
```

### Get a JWT for the Dev User

Chat and status routes require a Supabase JWT. Get one by logging in as the dev user:

```bash
ANON_KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY webapp/.env.local | cut -d= -f2)

TOKEN=$(curl -s -X POST "http://localhost:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@magister.local","password":"dev-password-not-for-production"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo $TOKEN
```

### Machine Status (JWT Auth)

```bash
ANON_KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY webapp/.env.local | cut -d= -f2)

TOKEN=$(curl -s -X POST "http://localhost:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@magister.local","password":"dev-password-not-for-production"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl http://localhost:8080/api/status \
  -H "Authorization: Bearer $TOKEN"
```

### Chat with the Agent (JWT Auth, SSE)

```bash
ANON_KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY webapp/.env.local | cut -d= -f2)

TOKEN=$(curl -s -X POST "http://localhost:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@magister.local","password":"dev-password-not-for-production"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -N -X POST http://localhost:8080/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you do?"}'
```

The `-N` flag disables output buffering so you see SSE chunks in real time.

### OpenClaw Direct (bypassing gateway)

```bash
curl http://localhost:18789/health
```

## Stopping and Resetting

```bash
make down          # stop containers
make reset         # stop, nuke volumes, reset DB, restart
```

## Auth Model Reference

The gateway uses three auth mechanisms:

| Auth Type | Header | Used By | Routes |
|-----------|--------|---------|--------|
| JWT (Supabase) | `Bearer <supabase_jwt>` | Frontend users | `/api/chat`, `/api/status` |
| API Key | `Bearer <GATEWAY_API_KEY>` | Vercel webhooks | `/api/provision`, `/api/destroy` |
| Machine Token | `Bearer <GATEWAY_TOKEN>` | OpenClaw machines | `/llm/v1/*` |

## Troubleshooting

**Containers won't start:**

```bash
docker compose ps     # check container status
make logs             # check for errors
```

**`user-machine` exits immediately:** The `OPENCLAW_IMAGE` in `.env.docker` doesn't exist. Run `make image-build` first, then set `OPENCLAW_IMAGE=registry.fly.io/magister-openclaw:latest`.

**Gateway can't reach Supabase:** Make sure local Supabase is running (`make db-start`) and `SUPABASE_URL` in `.env.docker` uses `host.docker.internal` (not `localhost`).

**JWT login fails:** Run `make db-reset` to re-seed the dev user. The seed script creates the user via the GoTrue admin API with password `dev-password-not-for-production`.

**Chat returns 404 "No machine found":** The dev machine row is missing. Run `make db-reset` to re-seed it.
