"""Test that email config fields exist and have correct defaults."""
from app.config import Settings


def test_email_config_defaults():
    """Email settings should have sensible defaults."""
    settings = Settings(
        supabase_url="https://test.supabase.co",
        supabase_service_role_key="test-key",
        supabase_jwt_secret="test-jwt",
        openrouter_api_key="test-or",
        fly_api_token="test-fly",
        fly_org="test-org",
        gateway_api_key="test-gw",
    )
    assert settings.resend_api_key == ""
    assert settings.agent_email_domain == "agent.magistermarketing.com"
    assert settings.resend_webhook_secret == ""
