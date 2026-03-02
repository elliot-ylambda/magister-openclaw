# Production Setup — Fly.io Deployment

Two components are deployed to Fly.io:

| Component | Fly App | What It Does |
|-----------|---------|-------------|
| **Gateway** | `magister-gateway` | Always-on FastAPI proxy (auth, chat routing, LLM proxy, idle sweep) |
| **User Machine Image** | `magister-user-machine` | Docker image in Fly registry; per-user machines created dynamically via API |

The webapp (Next.js) deploys to Vercel separately.

---

## Prerequisites

- Install `flyctl`: `brew install flyctl`
- Authenticate: `flyctl auth login`
- Have a Fly.io org ready (`flyctl orgs list` to check)
- Supabase project set up with migrations applied
- Anthropic API key

---

## Step 1: Build & Push the User Machine Image

This must happen first — the gateway references this image when provisioning machines.

```bash
# Create the registry app (one-time)
flyctl apps create magister-user-machine

# Build and push (from repo root)
make deploy-image
```

---

## Step 2: Generate Keys

### GATEWAY_API_KEY

Shared secret between Vercel webapp and the gateway. You create it:

```bash
openssl rand -base64 32
```

Set the same value in both the gateway (Step 3) and Vercel env vars.

### FLY_API_TOKEN

Org-level token so the gateway can create apps, volumes, and machines at runtime:

```bash
flyctl tokens create org
```

Outputs a token starting with `fo1_...`.

### FLY_ORG

Your Fly org slug. Find it via:

```bash
flyctl orgs list
```

### SUPABASE_JWT_SECRET

Found in Supabase dashboard: **Settings > API > JWT Secret** (the legacy HS256 key).

---

## Step 3: Deploy the Gateway

```bash
cd gateway/

# Create the app (one-time — already defined in fly.toml)
flyctl apps create magister-gateway

# Set all required secrets
flyctl secrets set -a magister-gateway \
  SUPABASE_URL="https://<project>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
  SUPABASE_JWT_SECRET="<jwt-secret-from-supabase-dashboard>" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  GATEWAY_API_KEY="<your-generated-key>" \
  FLY_API_TOKEN="fo1_..." \
  FLY_ORG="<your-org-slug>" \
  OPENCLAW_IMAGE="registry.fly.io/magister-user-machine:latest"

# Deploy (from repo root)
make deploy-gateway
```

This builds the Dockerfile, pushes it, and rolls out 2 instances in `iad` (configured in `fly.toml`).

### Optional: Slack integration

If Slack is enabled, also set:

```bash
flyctl secrets set \
  SLACK_CLIENT_ID="..." \
  SLACK_CLIENT_SECRET="..." \
  SLACK_SIGNING_SECRET="..." \
  SLACK_APP_ID="..." \
  SLACK_REDIRECT_URI="https://<webapp-url>/api/slack/callback" \
  WEBAPP_URL="https://<webapp-url>" \
  -a magister-gateway
```

---

## Step 4: Configure Vercel (Webapp)

Set these environment variables in Vercel:

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `NEXT_PUBLIC_GATEWAY_URL` | `https://magister-gateway.fly.dev` (browser-facing) |
| `GATEWAY_URL` | `https://magister-gateway.fly.dev` (server-side) |
| `GATEWAY_API_KEY` | Same key generated in Step 2 |

---

## Step 5: Verify

```bash
# Gateway status
flyctl status -a magister-gateway

# Gateway logs
flyctl logs -a magister-gateway

# List all apps (user machines appear as magister-{userId[:8]})
flyctl apps list
```

---

## How User Machines Get Provisioned

This happens automatically when a user subscribes (Stripe webhook -> Vercel -> gateway):

1. Creates a Fly app: `magister-{userId[:8]}`
2. Generates a bearer token, sets it as a Fly secret
3. Creates a 5GB volume in `iad`
4. Creates a machine (shared-cpu-2x, 2GB RAM) using the `magister-user-machine` image
5. Waits for `started` state

---

## Updating the User Machine Image

### Push new image only (new machines get it, existing machines unchanged)

```bash
make deploy-image
```

### Rolling update all existing machines

```bash
make deploy-machines
```

This lists all `magister-*` apps (excluding the gateway and registry app), then for each machine:
- **Running machines**: restarts with the new image (brief downtime per user)
- **Suspended/stopped machines**: updates config only, machine stays asleep until next chat request

### Deploy everything (image + gateway + rolling update)

```bash
make deploy-all
```

---

## Architecture Notes

- Gateway runs 2 always-on instances (`min_machines_running = 2`, `auto_stop_machines = "off"`)
- User machines communicate with the gateway over Fly's private network (`magister-gateway.internal:8080`)
- The gateway's idle sweep suspends inactive machines after 10 minutes (saves cost)
- Suspended machines resume in ~300ms when the next chat request arrives
