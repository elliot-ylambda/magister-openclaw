# Gateway CLAUDE.md

See root `../CLAUDE.md` for full architecture, commands, and project overview.

This file covers gateway-specific development patterns.

## Quick Commands

| Task | Command |
|------|---------|
| Install deps | `make gateway-install` (creates .venv, pip install) |
| Dev server | `make gateway-dev` (uvicorn on port 8080) |
| Run all tests | `make gateway-test` |
| Run single test | `cd gateway && .venv/bin/python -m pytest tests/path/to/test.py -v` |
| Lint | `make gateway-lint` |

## Stack

- **Python 3.12**, venv-based (`requirements.txt`)
- **FastAPI** with async lifespan pattern (services + routes initialized at startup)
- **pydantic-settings** for config (`app/config.py`, reads env vars)
- **litellm** for LLM proxy via OpenRouter or direct provider APIs for BYOK (enforces plan-based model allowlists + budgets)
- **httpx** async client for Fly.io API calls
- **sse-starlette** for streaming SSE responses
- **pytest** + pytest-asyncio for tests

## Structure

```
app/
├── main.py              — FastAPI app, lifespan, route registration
├── config.py            — Settings (pydantic-settings, env vars)
├── models.py            — Pydantic models (MachineStatus, UserMachine, ChatRequest, etc.)
├── routes/
│   ├── chat.py          — SSE chat proxy to user machines (JWT auth)
│   ├── provision.py     — Provision per-user Fly apps/machines (API key auth)
│   ├── destroy.py       — Destroy user machines (API key auth)
│   ├── status.py        — Machine status endpoint (JWT auth)
│   ├── llm_proxy.py     — /llm/v1 proxy for user machines → OpenRouter (supports BYOK keys)
│   ├── model_selection.py — Model listing, switching, admin default (JWT or API key auth)
│   ├── machine_control.py — Start/stop/restart machines (JWT or API key auth)
│   ├── files.py         — File management on user machines (JWT or API key auth)
│   ├── admin_secrets.py — Push/manage secrets on user machines (API key auth)
│   ├── slack_webhook.py — Slack events/commands handler
│   ├── slack_oauth.py   — Slack OAuth flow (API key auth)
│   └── health.py        — Health check
├── services/
│   ├── fly.py           — Fly.io Machines API client (provision, destroy, start, stop, etc.)
│   ├── llm.py           — LLM proxy logic (budget tracking, model allowlists, BYOK key resolution, OpenRouter forwarding)
│   └── supabase_client.py — Supabase service (user machines CRUD, subscriptions, chat, Slack connections, BYOK keys, app settings)
├── middleware/
│   ├── auth.py          — JWT verification + API key verification (dual auth mode)
│   └── rate_limit.py    — In-memory per-user rate limiter
└── jobs/
    ├── idle_sweep.py    — Auto-suspend idle machines (currently disabled)
    └── reconciliation.py — Periodic sync of Fly machine state with DB
```

## Key Patterns

- **Lifespan pattern**: all services (Fly, Supabase, LLM) are created in the `lifespan` context manager and injected into route factories via closures — not global state
- **Dual auth**: JWT for user-facing requests (from webapp), API key for internal requests (from Vercel webhooks)
- **Route factories**: each route module exports a `create_*_router()` function that takes service dependencies — enables testability
- **Chat proxy**: gateway does NOT run LLM calls directly for chat; it proxies SSE from the user's Fly machine. The `/llm/v1` endpoint is called by the user machine back to the gateway for actual LLM inference
- **Plan enforcement**: `app/config.py` defines `plan_budgets` and `plan_allowed_models` per subscription tier (cmo, cmo_plus)
- **BYOK (Bring Your Own Key)**: users can provide their own API keys for providers (openrouter, anthropic, openai, gemini). When a BYOK key exists, the LLM proxy routes directly to the provider instead of OpenRouter, and usage costs are recorded as $0
- **Model selection**: users can switch their agent's default model via `model_selection.py` routes. `SWITCHABLE_MODELS` in `config.py` defines the available models. Admin can set a default model for new machines via `app_settings`

## Auth Modes

- **JWT** (`verify_jwt`): validates Supabase JWT from `Authorization: Bearer <token>`, extracts `user_id`
- **API key** (`verify_api_key`): validates `X-API-Key` header against `GATEWAY_API_KEY` env var

## Testing

- Tests in `tests/` mirror the `app/` structure (`test_routes/`, `test_services/`, `test_jobs/`, `test_middleware/`)
- Fixtures in `tests/conftest.py` — shared mocks for settings, services, auth, and FastAPI test client
- Uses `pytest-asyncio` for async test support
- Run with: `make gateway-test` or `pytest` from gateway dir with venv activated

## Environment

Key env vars (see `app/config.py` for all):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- `OPENROUTER_API_KEY` — LLM provider key (used by litellm)
- `GATEWAY_API_KEY` — shared secret for internal API key auth
- `FLY_API_TOKEN`, `FLY_ORG` — Fly.io credentials (optional for local dev)
- `DEV_MACHINE_URL` — local dev override, skips Fly DNS
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_APP_ID`
