from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    port: int = 8080

    # Gateway API key (used by Vercel webhook for provision/destroy)
    gateway_api_key: str = ""

    # Fly.io (optional for local dev — required in production)
    fly_api_token: str = ""
    fly_org: str = ""

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # LLM — OpenRouter (used by litellm for all LLM requests)
    openrouter_api_key: str

    # OpenClaw image (optional for local dev — required in production)
    openclaw_image: str = ""

    # Slack integration
    slack_client_id: str = ""
    slack_client_secret: str = ""
    slack_signing_secret: str = ""
    slack_app_id: str = ""
    slack_redirect_uri: str = ""
    webapp_url: str = ""

    # Dev override: when set, all chat/health requests go to this URL
    # instead of Fly internal DNS.  Set via DEV_MACHINE_URL in .env.gateway.docker.
    dev_machine_url: str = ""

    # Defaults
    default_region: str = "iad"
    default_budget_cents: int = 5000  # $50

    # Plan budgets (cents per month)
    plan_budgets: dict[str, int] = {
        "cmo": 5000,        # $50/mo
        "cmo_plus": 15000,  # $150/mo
    }

    # Per-plan model allowlists (provider/model format for OpenRouter)
    plan_allowed_models: dict[str, list[str]] = {
        "cmo": [
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-haiku-4-5",
            "openai/gpt-4o",
            "google/gemini-2.5-flash",
        ],
        "cmo_plus": [
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-haiku-4-5",
            "anthropic/claude-opus-4-6",
            "openai/gpt-4o",
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash",
        ],
    }

    model_config = {"env_prefix": "", "case_sensitive": False}
