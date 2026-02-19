from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    port: int = 8080

    # Fly.io (optional for local dev — required in production)
    fly_api_token: str = ""
    fly_org: str = ""

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # LLM (Anthropic key used by litellm directly)
    anthropic_api_key: str

    # OpenClaw image (optional for local dev — required in production)
    openclaw_image: str = ""

    # Defaults
    default_region: str = "iad"
    default_budget_cents: int = 5000  # $50

    # Plan budgets (cents per month)
    plan_budgets: dict[str, int] = {
        "cmo": 5000,        # $50/mo
        "cmo_plus": 15000,  # $150/mo
    }

    # Per-plan model allowlists (CMO users cannot access Opus)
    plan_allowed_models: dict[str, list[str]] = {
        "cmo": ["claude-sonnet-4-6", "claude-haiku-4-5"],
        "cmo_plus": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
    }

    model_config = {"env_prefix": "", "case_sensitive": False}
