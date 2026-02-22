# Local Development Setup

Run the full stack locally: Supabase (Postgres) + Gateway (FastAPI) + User Machine (OpenClaw) + Webapp (Next.js).

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
cd webapp && make supabase-start-local
```

Boots Postgres (54322), API (54321), and Studio (54323). Note the keys printed on startup — you'll need **service_role key** and **JWT secret**.

To view keys again later:

```bash
cd webapp && pnpm supabase status
```

### 2. Reset the Database

```bash
cd webapp && make supabase-reset-local
```

Applies all migrations and runs seed migrations that create a dev auth user and machine row:

| What | Value |
|------|-------|
| Dev user email | `dev@magister.local` |
| Dev user password | `dev-password-not-for-production` |
| Dev user ID | `00000000-0000-0000-0000-000000000001` |
| Dev user role | `admin` |
| Dev machine ID | `00000000-0000-0000-0000-000000000002` |
| Machine status | `running` |
| Gateway token | `dev-local-token-magister-2026` |

### 3. Create env files

#### Gateway — `.env.docker`

Copy the example and fill in the Supabase keys and your Anthropic API key:

```bash
cp .env.docker.example .env.docker
```

Then edit `.env.docker`:

```env
# From `cd webapp && pnpm supabase status`
SUPABASE_URL=http://host.docker.internal:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
SUPABASE_JWT_SECRET=<from supabase status>

# Your Anthropic key (used by the LLM proxy)
ANTHROPIC_API_KEY=sk-ant-...

# Leave as-is for local dev
GATEWAY_API_KEY=dev-gateway-api-key-local-unsafe

# Local dev: route chat/health to Docker service instead of Fly internal DNS
DEV_MACHINE_URL=http://user-machine:18789

# Set after building the image (step 4)
OPENCLAW_IMAGE=magister-openclaw:local

# Must match gateway_token in seed migration
DEV_GATEWAY_TOKEN=dev-local-token-magister-2026
```

#### Webapp — `webapp/.env.local`

Copy the example and fill in the Supabase keys:

```bash
cp webapp/.env.example webapp/.env.local
```

Then edit `webapp/.env.local`:

```env
# App
NEXT_PUBLIC_APP_URL=http://localhost:3020

# Supabase (from `cd webapp && pnpm supabase status`)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>

# Gateway (matches the Docker gateway port)
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080
```

> **Note:** `NEXT_PUBLIC_GATEWAY_URL` must point to `http://localhost:8080` — the port exposed by docker-compose.

### 4. Build the OpenClaw Image

The docker-compose `user-machine` service requires a pre-built image. Build it locally:

```bash
docker build -t magister-openclaw:local ./openclaw-image
```

This clones OpenClaw, installs Chromium, copies marketing skills, and sets up the entrypoint. The first build takes a few minutes; subsequent builds are fast due to Docker layer caching.

Before building, copy the marketing skills into the Docker build context:

```bash
cp -r marketingskills/ openclaw-image/skills/
```

### 5. Start the Backend Stack

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

### 6. Start the Webapp

```bash
cd webapp && make install && make dev
```

This installs pnpm dependencies and starts the Next.js dev server on `http://localhost:3020`.

### 7. Test End-to-End

1. Open `http://localhost:3020` in your browser
2. Log in as `dev@magister.local` / `dev-password-not-for-production`
3. Navigate to `/chat` and send a message — it should stream from the local OpenClaw container

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

The seed migration already created a running machine for the dev user, so this returns `already_running`:

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
curl http://localhost:8080/api/status \
  -H "Authorization: Bearer $TOKEN"
```

### Chat with the Agent (JWT Auth, SSE)

```bash
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

## How `DEV_MACHINE_URL` Works

In production, the gateway constructs machine URLs using Fly's internal DNS: `http://{machine_id}.vm.{app_name}.internal:18789`. This only resolves inside Fly's network.

When `DEV_MACHINE_URL` is set (e.g. `http://user-machine:18789`), the gateway:
- Routes all chat and health-check requests to that URL instead
- Skips `fly.start_machine()` wake-up calls (no Fly API locally)
- Skips `fly.suspend_machine()` in the idle sweep (can't reach Fly API locally)

When `DEV_MACHINE_URL` is empty (the production default), behavior is identical to before.

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

**`user-machine` exits immediately:** The `OPENCLAW_IMAGE` in `.env.docker` doesn't exist. Build it first: `docker build -t magister-openclaw:local ./openclaw-image`

**Gateway can't reach Supabase:** Make sure local Supabase is running (`cd webapp && make supabase-start-local`) and `SUPABASE_URL` in `.env.docker` uses `host.docker.internal` (not `localhost`).

**JWT login fails:** Run `cd webapp && make supabase-reset-local` to re-seed the dev user.

**Chat returns 404 "No machine found":** The dev machine row is missing. Run `cd webapp && make supabase-reset-local` to re-seed it.

**Chat returns 503 "Machine not ready":** The user-machine container isn't responding. Check `make logs` and ensure the OpenClaw image was built correctly.

**Webapp shows "Gateway URL not configured":** Make sure `NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080` is set in `webapp/.env.local` and restart the dev server.
