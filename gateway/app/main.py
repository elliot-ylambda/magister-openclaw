"""Magister Gateway — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.jobs.idle_sweep import start_idle_sweep
from app.middleware.auth import create_api_key_dependency, create_jwt_dependency
from app.middleware.rate_limit import RateLimiter
from app.routes.chat import create_chat_router
from app.routes.destroy import create_destroy_router
from app.routes.health import router as health_router
from app.routes.llm_proxy import create_llm_proxy_router
from app.routes.provision import create_provision_router
from app.routes.status import create_status_router
from app.services.fly import FlyClient
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────
    settings = Settings()
    app.state.settings = settings

    # Core services
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
    app.state.supabase = supabase
    app.state.fly = fly
    app.state.llm = llm

    # Auth dependencies
    verify_jwt = create_jwt_dependency(settings.supabase_jwt_secret)
    verify_api_key = create_api_key_dependency(settings.gateway_api_key)

    # Rate limiter
    rate_limiter = RateLimiter(max_requests=20, window_seconds=60.0)

    # ── Routes ────────────────────────────────────────────────
    app.include_router(health_router)

    app.include_router(
        create_chat_router(fly, supabase, rate_limiter, verify_jwt),
        prefix="/api",
    )
    app.include_router(
        create_status_router(fly, supabase, verify_jwt),
        prefix="/api",
    )
    app.include_router(
        create_provision_router(fly, supabase, settings),
        prefix="/api",
        dependencies=[verify_api_key],
    )
    app.include_router(
        create_destroy_router(fly, supabase),
        prefix="/api",
        dependencies=[verify_api_key],
    )
    app.include_router(
        create_llm_proxy_router(llm, supabase),
        prefix="/llm",
    )

    # ── Background jobs ───────────────────────────────────────
    sweep_task = start_idle_sweep(fly, supabase, rate_limiter)
    logger.info("[gateway] All routes registered, idle sweep started")

    yield

    # ── Shutdown ──────────────────────────────────────────────
    sweep_task.cancel()
    try:
        await sweep_task
    except Exception:
        pass
    await fly.close()
    logger.info("[gateway] Shutdown complete")


app = FastAPI(title="Magister Gateway", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
