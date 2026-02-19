from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app.config import Settings
from app.services.fly import FlyClient
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate settings on startup (fail fast if env is misconfigured)
    settings = Settings()
    app.state.settings = settings

    # Initialize core services
    app.state.supabase = await SupabaseService.create(
        settings.supabase_url, settings.supabase_service_role_key
    )
    app.state.fly = FlyClient(settings.fly_api_token, settings.fly_org)
    app.state.llm = LLMService(
        anthropic_api_key=settings.anthropic_api_key,
        supabase=app.state.supabase,
        plan_budgets=settings.plan_budgets,
        plan_allowed_models=settings.plan_allowed_models,
    )

    yield

    # Shutdown: close HTTP clients
    await app.state.fly.close()


app = FastAPI(title="Magister Gateway", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": app.version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
