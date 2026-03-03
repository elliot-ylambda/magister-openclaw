# Local Webapp + Production Infrastructure

Run the Next.js webapp locally while using the **production gateway** on Fly.io and **production Supabase**. Real Fly machines are provisioned — no Docker containers needed.

## Prerequisites

- Webapp dependencies installed (`make webapp-install`)
- Production gateway deployed to Fly.io (see [prod-setup.md](./prod-setup.md))
- User machine image pushed to Fly registry (`make deploy-image`)
- Access to the production Supabase dashboard (for keys and user IDs)

## Step 1: Configure the Webapp

Update `webapp/.env.local` to point at production services:

```env
# App
NEXT_PUBLIC_APP_URL=http://localhost:3020

# Supabase — use PRODUCTION values (not local)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<production-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<production-service-role-key>

# Gateway — use PRODUCTION URL
NEXT_PUBLIC_GATEWAY_URL=https://magister-gateway.fly.dev
GATEWAY_URL=https://magister-gateway.fly.dev
GATEWAY_API_KEY=<production-gateway-api-key>

# Stripe (use test keys — checkout still works against Stripe test mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_CMO_PRICE_ID=price_...
STRIPE_CMO_PLUS_PRICE_ID=price_...

# Resend
RESEND_API_KEY=re_...
```

> **Important:** The gateway validates JWTs using the production `SUPABASE_JWT_SECRET`. You must use production Supabase so the tokens match.

## Step 2: Start the Webapp

```bash
make webapp-dev
```

This starts the Next.js dev server on `localhost:3020` (and the Stripe webhook listener).

## Step 3: Provision a Machine

You need a real user in production Supabase. Either sign up through the webapp or use an existing user.

### Option A: Sign up through the UI

1. Open `http://localhost:3020`
2. Create an account (this creates a user in production Supabase)
3. Complete a Stripe checkout (test mode) — this triggers provisioning automatically

### Option B: Provision manually (skip Stripe)

Get your user ID from the Supabase dashboard (**Authentication > Users**), then:

```bash
curl -X POST https://magister-gateway.fly.dev/api/provision \
  -H "Authorization: Bearer <PRODUCTION_GATEWAY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<your-user-id>", "plan": "cmo"}'
```

Expected response:

```json
{"status": "provisioned", "machine_id": "..."}
```

## Step 4: Test

Open `http://localhost:3020`, log in, and navigate to chat. Messages flow:

```
Browser (localhost:3020)
  → magister-gateway.fly.dev/api/chat  (JWT auth)
    → <machine>.vm.<app>.internal:18789  (Fly private network)
```

### Test chat from the terminal

Get a JWT by logging in via Supabase Auth:

```bash
curl -s -X POST "https://<project>.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <production-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"<your-email>","password":"<your-password>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
```

Then send a chat request:

```bash
TOKEN="<paste-token-here>"

# Streaming (SSE)
curl -N -X POST https://magister-gateway.fly.dev/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you do?", "stream": true}'

# Non-streaming (JSON)
curl -s -X POST https://magister-gateway.fly.dev/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you do?", "stream": false}' | python3 -m json.tool
```

## Verify Machine Status

```bash
# Via the gateway API
TOKEN="<your-jwt>"
curl -s https://magister-gateway.fly.dev/api/status \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Via flyctl
flyctl status -a magister-<first-8-chars-of-user-id>
flyctl machine list -a magister-<first-8-chars-of-user-id>

# Gateway logs
flyctl logs -a magister-gateway
```

## Cleanup

Destroy the test machine when done to avoid costs:

```bash
# Via the gateway
curl -X POST https://magister-gateway.fly.dev/api/destroy \
  -H "Authorization: Bearer <PRODUCTION_GATEWAY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<your-user-id>"}'

# Or directly via flyctl
flyctl apps destroy magister-<first-8-chars> --yes
```

## Switching Back to Local Dev

Restore `webapp/.env.local` to local values:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key>

NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080
GATEWAY_URL=http://localhost:8080
GATEWAY_API_KEY=dev-gateway-api-key-local-unsafe
```

Then follow [local-dev-setup.md](./local-dev-setup.md) to start the local stack.

## Notes

- The Makefile targets `make health`, `make status`, `make chat`, and `make provision` are hardcoded to `localhost:8080` and only work with a local gateway. Use the curl commands above for production.
- `make webapp-dev` and `make webapp-install` work regardless of which backend you're pointed at.
- `make deploy-gateway` and `make deploy-image` can be used to redeploy production infrastructure.
- The gateway's idle sweep will suspend your machine after 10 minutes of inactivity. The next chat request wakes it automatically (~300ms).
