# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Magister Marketing is an autonomous AI marketing agent platform. The monorepo contains three services:

- **webapp/** — Next.js frontend (marketing site + authenticated app with chat, dashboard, settings)
- **gateway/** — Python FastAPI backend that proxies chat to per-user Fly.io machines, handles LLM routing, billing, and Slack integration
- **openclaw-image/** — Docker image for user-provisioned AI agent machines running on Fly.io

## Commands

All commands run from the **repo root** via the top-level Makefile:

| Task | Command |
|------|---------|
| **Pre-PR Check** | |
| Build + lint all | `make check` (webapp build + webapp lint + gateway lint — **run before pushing to a PR**) |
| **Webapp** | |
| Install deps | `make webapp-install` (uses pnpm) |
| Dev server | `make webapp-dev` (port 3020, also starts Stripe webhook listener) |
| Build | `make webapp-build` |
| Lint | `make webapp-lint` |
| Clean | `make webapp-clean` |
| Run all tests | `cd webapp && pnpm test:run` |
| Run single test | `cd webapp && pnpm vitest run path/to/file.test.ts` |
| **Gateway** | |
| Install deps | `make gateway-install` (creates .venv, pip install) |
| Dev server | `make gateway-dev` (uvicorn on port 8080) |
| Run all tests | `make gateway-test` |
| Run single test | `cd gateway && .venv/bin/python -m pytest tests/path/to/test.py -v` |
| Lint | `make gateway-lint` |
| **Supabase** | |
| Start local | `make supabase-start` |
| Run migrations | `make supabase-migrate` |
| Reset DB (with seed) | `make supabase-reset` |
| Seed only | `make seed` |
| Connect psql | `make connect-local-db` |
| **Docker (full stack)** | |
| Start all | `make up` (gateway + user-machine) |
| Stop all | `make down` |
| Logs | `make logs` |
| Reset (wipe volumes + reseed) | `make reset` |
| **OpenClaw Image** | |
| Build locally | `make image-build` |
| Push to registry | `make image-push` |
| Pin to current HEAD | `make openclaw-pin` (updates Dockerfile ARG) |
| **Production Deploy (Fly.io)** | |
| Deploy gateway | `make deploy-gateway` |
| Deploy machine image | `make deploy-image` (remote build + push to Fly registry) |
| Rolling update machines | `make deploy-machines` |
| Deploy everything | `make deploy-backend` (image + gateway + machines + start all) |
| **Production Start/Stop** | |
| Start gateway | `make start-gateway` |
| Stop gateway | `make stop-gateway` |
| Start all user machines | `make start-machines` |
| Stop all user machines | `make stop-machines` |
| Start one machine | `make start-machine app=magister-XXXXXXXX` |
| Stop one machine | `make stop-machine app=magister-XXXXXXXX` |
| **Local Dev Testing** | |
| Chat (JSON) | `make chat m="Hello"` |
| Chat (SSE stream) | `make chat m="Hello" s=true` |
| Continue session | `make chat m="Hello" sid=<session_id>` |
| Health check | `make health` |
| Machine status | `make status` |
| Provision machine | `make provision` |
| Slack challenge test | `make slack-challenge` |
| **Admin** | |
| Delete a user | `make delete-user email=user@example.com` (destroys machine, cancels Stripe, removes from Supabase) |
| Make user admin | `make make-admin email=user@example.com` |

## Pre-PR Workflow

**Always run `make check` before pushing a branch or creating a PR.** This runs the webapp build, webapp lint, and gateway lint. All three must pass before code is pushed. Do not skip this step.

## Architecture

### Request Flow

```
Browser → Next.js webapp (Vercel) → Gateway (Fly.io) → User Machine (Fly.io per-user app)
                                         ↓
                                    LLM Proxy → OpenRouter → LLM providers (via litellm)
```

1. User sends a chat message from the webapp
2. Webapp streams POST to `gateway/api/chat` with Supabase JWT
3. Gateway looks up the user's Fly machine, starts it if suspended, proxies the request via SSE
4. The user machine (OpenClaw) makes LLM calls back through the gateway's `/llm/v1` proxy endpoint
5. Gateway enforces per-plan model allowlists and budget limits, resolves BYOK keys if present, then forwards to OpenRouter (or directly to the provider for BYOK) via litellm

### Webapp (`webapp/`)

- **Next.js 16** / React 19 / TypeScript / App Router
- **Tailwind CSS v4** (PostCSS plugin — no `tailwind.config.js`)
- **shadcn/ui** components in `src/components/ui/` (new-york style, Lucide icons)
- **Supabase** for auth and database (`@supabase/ssr` for SSR cookie handling)
- **Stripe** for billing (checkout, portal, webhooks)
- **Vitest** + Testing Library for tests
- **Resend** for transactional email
- Package manager: **pnpm** (not npm/yarn)
- Path alias: `@/*` → `./src/*`

Route groups:
- `(app)/` — authenticated app pages (chat, dashboard, settings, files) with sidebar layout
- `(admin)/` — admin pages (machine management, secrets, user management)
- `(auth)/` — login, signup, reset-password
- `/` root — public marketing landing page (`page.tsx`, ~2000 lines, self-contained)
- `api/` — Next.js API routes for Stripe, Slack, billing webhooks, admin, machine control, BYOK key management, model selection

Supabase clients:
- `src/lib/supabase/client.ts` — browser client (anon key, singleton)
- `src/lib/supabase/server.ts` — server client (cookie-based) + service client (service-role key)
- `src/lib/supabase/middleware.ts` — session refresh in Next.js middleware

Key libs:
- `src/lib/gateway.ts` — SSE streaming client + agent status/control helpers + model selection API
- `src/lib/stripe.ts` — Stripe client and price/plan mapping
- `src/lib/auth.ts` — auth utilities (getUser, requireAuth helpers)
- `src/middleware.ts` — auth routing (public vs protected routes, redirects)

### Gateway (`gateway/`)

- **FastAPI** with async lifespan pattern (services + routes initialized at startup)
- **Python 3.12**, venv-based, dependencies in `requirements.txt`
- **pydantic-settings** for config (`app/config.py`, reads env vars)
- **litellm** for LLM proxy via OpenRouter (enforces plan-based model allowlists + budgets)
- **httpx** async client for Fly.io API calls
- **sse-starlette** for streaming SSE responses
- **pytest** + pytest-asyncio for tests

Structure:
- `app/routes/` — route modules (chat, provision, destroy, status, llm_proxy, model_selection, machine_control, files, admin_secrets, slack_webhook, slack_oauth, health)
- `app/services/` — core services (fly.py for Fly.io API, llm.py for LLM proxy, supabase_client.py)
- `app/middleware/` — JWT auth + API key auth + rate limiting
- `app/jobs/` — background tasks (idle_sweep currently disabled, reconciliation syncs Fly state with DB)
- `app/models.py` — Pydantic models (MachineStatus enum, UserMachine, ChatRequest, etc.)
- `app/config.py` — Settings class with plan budgets, model allowlists, Fly/Supabase/Slack config

Auth: dual-mode — JWT (user requests from webapp) and API key (internal/webhook requests from Vercel)

### User Machines (`openclaw-image/`) & OpenClaw Reference

Docker image deployed to per-user Fly.io apps. Each user gets an isolated Fly app with one machine. The gateway provisions/destroys these via the Fly.io Machines API. Machines auto-suspend after idle timeout and wake on chat request.


### IMPORTANT: OpenClaw Reference
**When you have questions about how OpenClaw works, need to understand its API, or are debugging integration issues — always consult these sources:**

1. **Our fork (active development)**: `../magister-openclaw/` — this is where we make changes; the production Dockerfile clones from `github.com/elliot-ylambda/magister-openclaw`
2. **Upstream reference (read-only)**: `../openclaw/` — the original OpenClaw repo, useful for understanding internals and pulling updates
3. **Documentation**: https://docs.openclaw.ai

**Workflow for OpenClaw changes:** edit `../magister-openclaw/` → commit + push → `make openclaw-pin` → `make deploy-image`

Read the actual OpenClaw source and docs rather than guessing at behavior. The gateway's chat proxy, LLM proxy, and machine lifecycle all depend on OpenClaw's internal APIs and conventions.

### Database (Supabase)

Migrations in `webapp/supabase/migrations/`. Key tables:
- `waitlist` — email signups + survey data
- `user_machines` — per-user Fly machine state (status, plan, region, tokens, images, preferred_model)
- `profiles` — user profiles linked to auth.users
- `subscriptions` — Stripe subscription state
- `chat_sessions` / `chat_messages` — conversation persistence (messages track which model generated them via `model` column)
- `slack_connections` — Slack OAuth tokens per user
- `signup_allowlist` — invite-gated signups
- `global_secrets` — admin-managed secrets pushed to user machines
- `user_api_keys` — BYOK (Bring Your Own Key) API keys per user per provider (openrouter, anthropic, openai, gemini)
- `app_settings` — admin-level app config (e.g. default model for new machines)

Seed data in `webapp/supabase/seed.sql` (dev user, profile, machine) — only runs on `supabase db reset --local`.

## Environment Variables

**Webapp** (`.env.local`):
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_GATEWAY_URL`
- Stripe keys, Resend key, Fathom analytics ID

**Gateway** (`.env.gateway.docker` or direct env):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- `OPENROUTER_API_KEY`, `GATEWAY_API_KEY`
- `FLY_API_TOKEN`, `FLY_ORG`
- `DEV_MACHINE_URL` (local dev override, skips Fly DNS)
- Slack credentials (optional)

## Deployment

- **Webapp**: Vercel (Next.js)
- **Gateway**: Fly.io (`magister-gateway` app, 2x shared-cpu, 2GB, min 2 instances)
- **User machines**: Fly.io (per-user apps, provisioned dynamically via Machines API)
- **Database**: Supabase (hosted)
