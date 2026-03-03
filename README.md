# Magister Marketing

Autonomous AI marketing agent platform. Monorepo with three services:

```
webapp/          — Next.js frontend (marketing site + authenticated app)
gateway/         — FastAPI backend (chat proxy, LLM routing, billing)
openclaw-image/  — Docker image for per-user AI agent machines (Fly.io)
```

## Architecture

```
Browser → Next.js (Vercel) → Gateway (Fly.io) → User Machine (Fly.io per-user)
                                   ↓
                              LLM Proxy → OpenRouter → LLM providers
```

## Quick Start

```bash
# Webapp
make webapp-install          # Install pnpm dependencies
make webapp-dev              # Dev server (port 3020 + Stripe webhooks)
make webapp-build            # Production build
make webapp-lint             # Lint

# Gateway
make gateway-install         # Create venv + install deps
make gateway-dev             # Uvicorn on port 8080
make gateway-test            # Run tests
make gateway-lint            # Lint

# Supabase
make supabase-start          # Start local Supabase
make supabase-migrate        # Run migrations
make supabase-reset          # Reset DB + seed
make connect-local-db        # Open psql
```

## Docker (Local Full Stack)

```bash
make up                      # Start gateway + user machine
make down                    # Stop all
make logs                    # Tail logs
make reset                   # Wipe volumes, reseed, restart
```

## Production Deploy (Fly.io)

```bash
make deploy-gateway          # Deploy gateway
make deploy-image            # Build + push user machine image (remote)
make deploy-machines         # Rolling update all user machines
make deploy-backend          # All of the above + start everything
```

## Production Start/Stop

```bash
make start-gateway           # Start gateway machines
make stop-gateway            # Stop gateway machines
make start-machines          # Start all user machines
make stop-machines           # Stop all user machines
make start-machine app=magister-XXXX   # Start one machine
make stop-machine app=magister-XXXX    # Stop one machine
```

## OpenClaw Image

```bash
make image-build             # Build locally
make image-push              # Push to registry
make openclaw-pin            # Pin to HEAD of ../magister-openclaw
```

## Local Dev Testing

```bash
make health                  # Gateway health check
make status                  # Machine status (requires local Supabase)
make provision               # Provision a dev machine
make chat m="Hello"          # Chat (JSON response)
make chat m="Hello" s=true   # Chat (SSE stream)
make chat m="Hello" sid=ID   # Continue a session
make slack-challenge         # Test Slack webhook verification
```

## Tech Stack

- **Webapp**: Next.js 16, React 19, TypeScript, Tailwind v4, shadcn/ui, Supabase, Stripe, Resend
- **Gateway**: FastAPI, Python 3.12, litellm, httpx, Supabase, Fly.io Machines API
- **Infra**: Fly.io (gateway + per-user machines), Vercel (webapp), Supabase (DB + auth)
