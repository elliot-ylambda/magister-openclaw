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

Applies all migrations, then runs `supabase/seed.sql` which creates a dev auth user and seeds a dev machine row:

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

This copies the example templates. Then fill in `.env.gateway.docker` (gateway):

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

> **Quick alternative:** If you just want to test the gateway container without the full agent, you can skip this step and set `OPENCLAW_IMAGE=alpine/openclaw:latest` in `.env.gateway.docker`. Chat and LLM proxy won't work end-to-end, but the gateway will start.

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

## Testing Slack Integration

There are two ways to test the Slack integration locally — one that doesn't require a Slack app at all, and one that tests the full end-to-end flow.

### Option A: Gateway-only (no Slack app needed)

Test the webhook endpoint directly with curl. This validates signature verification, URL challenge handling, event routing, and machine forwarding — without needing a real Slack workspace.

#### 1. Verify the URL challenge handler

```bash
# Compute a valid signature for the challenge payload
SIGNING_SECRET="test-signing-secret"

# Add the signing secret to .env.gateway.docker:
#   SLACK_SIGNING_SECRET=test-signing-secret
# Then restart: make up

BODY='{"type":"url_verification","challenge":"test-challenge-xyz"}'
TIMESTAMP=$(date +%s)
SIG_BASE="v0:${TIMESTAMP}:${BODY}"
SIGNATURE="v0=$(echo -n "$SIG_BASE" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"

curl -s -X POST http://localhost:8080/webhooks/slack \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $TIMESTAMP" \
  -H "x-slack-signature: $SIGNATURE" \
  -d "$BODY" | python3 -m json.tool
```

Expected:

```json
{"challenge": "test-challenge-xyz"}
```

#### 2. Verify signature rejection

```bash
curl -s -X POST http://localhost:8080/webhooks/slack \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H "x-slack-signature: v0=invalid" \
  -d '{"type":"event_callback"}'
```

Expected: `401 Invalid signature`

#### 3. Test event forwarding (requires a slack_connections row)

Insert a test Slack connection for the dev user:

```bash
make connect-local-db
```

```sql
INSERT INTO slack_connections (user_id, team_id, team_name, bot_token, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'T_DEV_TEAM',
  'Dev Workspace',
  'xoxb-fake-token',
  'active'
);
```

Then send a signed event:

```bash
SIGNING_SECRET="test-signing-secret"
BODY='{"type":"event_callback","team_id":"T_DEV_TEAM","event_id":"Ev001","event":{"type":"message","text":"hello"}}'
TIMESTAMP=$(date +%s)
SIG_BASE="v0:${TIMESTAMP}:${BODY}"
SIGNATURE="v0=$(echo -n "$SIG_BASE" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"

curl -s -X POST http://localhost:8080/webhooks/slack \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $TIMESTAMP" \
  -H "x-slack-signature: $SIGNATURE" \
  -d "$BODY"
```

Expected: `200` (immediate ack). Check gateway logs (`make logs`) — you should see the event being forwarded to the user-machine container.

### Option B: Full end-to-end (requires Slack app + ngrok)

This tests the complete OAuth → connect → DM → agent responds flow.

#### 1. Create a test Slack workspace

Go to [slack.com/create](https://slack.com/get-started#/createnew) and create a free workspace for testing.

#### 2. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From scratch":

- **App Name:** `Magister Dev`
- **Workspace:** your test workspace

Under **OAuth & Permissions → Bot Token Scopes**, add:

```
app_mentions:read, channels:history, channels:read, chat:write,
files:read, files:write, groups:history, groups:read,
im:history, im:read, im:write, reactions:read, reactions:write, users:read
```

Under **OAuth & Permissions → Redirect URLs**, add:

```
http://localhost:3020/api/slack/callback
```

Under **Event Subscriptions:**
- Enable Events
- Set Request URL after step 4 (ngrok must be running first)
- Subscribe to bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`

Note the **Client ID**, **Client Secret**, **Signing Secret**, and **App ID** from the app's Basic Information page.

#### 3. Configure env files

Add to `.env.gateway.docker` (gateway):

```env
SLACK_CLIENT_ID=<from Slack app>
SLACK_CLIENT_SECRET=<from Slack app>
SLACK_SIGNING_SECRET=<from Slack app>
SLACK_APP_ID=<from Slack app>
WEBAPP_URL=http://localhost:3020
```

Add to `webapp/.env.local` (webapp):

```env
SLACK_CLIENT_ID=<from Slack app>
SLACK_CLIENT_SECRET=<from Slack app>
SLACK_SIGNING_SECRET=<from Slack app>
GATEWAY_URL=http://localhost:8080
```

#### 4. Start ngrok

Slack needs a public URL to send events to your local gateway:

```bash
ngrok http 8080
```

Copy the ngrok URL (e.g., `https://abc123.ngrok-free.app`).

Go back to your Slack app → **Event Subscriptions** → Set the Request URL to:

```
https://abc123.ngrok-free.app/webhooks/slack
```

Slack will send a challenge request — the gateway handles this automatically and Slack should show "Verified".

#### 5. Restart the stack

```bash
make up
make webapp-dev   # in another terminal
```

#### 6. Connect Slack via OAuth

1. Open `http://localhost:3020` and log in as the dev user
2. Go to **Settings**
3. Click **Connect Slack** — this redirects to Slack's OAuth page
4. Authorize the app for your test workspace
5. You should be redirected back to Settings with "Slack workspace connected successfully"

#### 7. Test a DM

1. Open your test Slack workspace
2. Find the bot in your DM list (or search for the app name)
3. Send a message like "Hello, what can you do?"
4. The gateway should:
   - Receive the event via ngrok
   - Route it to the local user-machine container
   - The agent should respond in the Slack thread

Check `make logs` if something isn't working.

### Gateway unit tests

All Slack webhook logic is covered by unit tests that run without any Slack app:

```bash
make gateway-test
```

Or run just the Slack tests:

```bash
cd gateway && .venv/bin/python -m pytest tests/test_routes/test_slack_webhook.py -v
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
| API Key | `Bearer <GATEWAY_API_KEY>` | Vercel webhooks | `/api/provision`, `/api/destroy`, `/api/slack/*` |
| Machine Token | `Bearer <GATEWAY_TOKEN>` | OpenClaw machines | `/llm/v1/*` |
| Slack HMAC | `x-slack-signature` | Slack Events API | `/webhooks/slack` |

## Troubleshooting

**Containers won't start:**

```bash
docker compose ps     # check container status
make logs             # check for errors
```

**`user-machine` exits immediately:** The `OPENCLAW_IMAGE` in `.env.gateway.docker` doesn't exist. Run `make image-build` first, then set `OPENCLAW_IMAGE=registry.fly.io/magister-openclaw:latest`.

**Gateway can't reach Supabase:** Make sure local Supabase is running (`make db-start`) and `SUPABASE_URL` in `.env.gateway.docker` uses `host.docker.internal` (not `localhost`).

**JWT login fails:** Run `make db-reset` to re-seed the dev user. The seed file (`supabase/seed.sql`) creates the user with password `dev-password-not-for-production`.

**Chat returns 404 "No machine found":** The dev machine row is missing. Run `make db-reset` to re-seed it.

**Slack webhook returns 401:** Check that `SLACK_SIGNING_SECRET` is set in `.env.gateway.docker` and the gateway was restarted (`make up`). For curl testing, ensure the timestamp is fresh (within 5 minutes).

**Slack OAuth redirects to error page:** Verify `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` are set in `webapp/.env.local`. Also check that `GATEWAY_URL=http://localhost:8080` is set (not just `NEXT_PUBLIC_GATEWAY_URL`).

**Bot doesn't respond in Slack:** Check `make logs` for errors. Common issues: (1) ngrok URL changed after restart — update the Slack app's Event Subscriptions URL, (2) `slack_connections` row missing — check the DB, (3) machine not running — `make provision`.
