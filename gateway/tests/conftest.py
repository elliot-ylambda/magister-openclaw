"""Shared test fixtures for the gateway test suite."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.models import MachineStatus, UserMachine


@pytest.fixture
def settings() -> Settings:
    """Settings instance with test values — no real env vars needed."""
    return Settings(
        port=8080,
        fly_api_token="test-fly-token",
        fly_org="test-org",
        supabase_url="http://localhost:54321",
        supabase_service_role_key="test-service-role-key",
        supabase_jwt_secret="test-jwt-secret",
        anthropic_api_key="test-anthropic-key",
        openclaw_image="registry.fly.io/openclaw:test",
        default_region="iad",
        default_budget_cents=5000,
        plan_budgets={"cmo": 5000, "cmo_plus": 15000},
        plan_allowed_models={
            "cmo": ["claude-sonnet-4-6", "claude-haiku-4-5"],
            "cmo_plus": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
        },
    )


@pytest.fixture
def mock_supabase() -> AsyncMock:
    """AsyncMock of SupabaseService with sensible defaults."""
    mock = AsyncMock()
    mock.get_user_machine.return_value = None
    mock.get_user_machine_by_token_hash.return_value = None
    mock.create_user_machine.return_value = None
    mock.update_user_machine.return_value = None
    mock.update_last_activity.return_value = None
    mock.claim_idle_machines.return_value = []
    mock.get_monthly_llm_spend.return_value = 0
    mock.insert_usage_event.return_value = None
    return mock


@pytest.fixture
def mock_fly() -> AsyncMock:
    """AsyncMock of FlyClient."""
    mock = AsyncMock()
    mock.create_app.return_value = {"id": "test-app-id"}
    mock.delete_app.return_value = None
    mock.set_secrets.return_value = None
    mock.create_volume.return_value = {"id": "vol_test123"}
    mock.delete_volume.return_value = None
    mock.create_machine.return_value = {"id": "mach_test123", "state": "created"}
    mock.get_machine.return_value = {"id": "mach_test123", "state": "started"}
    mock.start_machine.return_value = None
    mock.stop_machine.return_value = None
    mock.suspend_machine.return_value = None
    mock.delete_machine.return_value = None
    mock.wait_for_state.return_value = None
    mock.close.return_value = None
    return mock


@pytest.fixture
def dev_user_machine() -> UserMachine:
    """UserMachine populated with dev seed data."""
    return UserMachine(
        id="00000000-0000-0000-0000-000000000010",
        user_id="00000000-0000-0000-0000-000000000001",
        fly_app_name="magister-dev-user",
        fly_machine_id="mach_dev123",
        fly_volume_id="vol_dev123",
        fly_region="iad",
        status=MachineStatus.running,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="dev-local-token-magister-2026",
        gateway_token_hash="sha256-hash-placeholder",
        pending_image=None,
        current_image="registry.fly.io/openclaw:latest",
        provisioning_step=0,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
