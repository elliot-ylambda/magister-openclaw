"""Tests for the /api/models and /api/admin/default-model routes."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import jwt as pyjwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, SWITCHABLE_MODELS
from app.models import MachineStatus, UserMachine
from app.routes.model_selection import create_model_selection_router

JWT_SECRET = "test-jwt-secret"
API_KEY = "test-gateway-api-key"
USER_ID = "user-1"


def _make_machine(
    status: MachineStatus = MachineStatus.running,
    plan: str = "cmo",
    preferred_model: str = "anthropic/claude-opus-4-6",
    **overrides,
) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id=USER_ID,
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=status,
        last_activity=datetime.now(timezone.utc),
        plan=plan,
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        preferred_model=preferred_model,
        current_image="registry.fly.io/openclaw:test",
        provisioning_step=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


def _jwt_for(user_id: str) -> str:
    return pyjwt.encode(
        {"sub": user_id, "aud": "authenticated"},
        JWT_SECRET,
        algorithm="HS256",
    )


@pytest.fixture
def settings():
    return Settings(
        port=8080,
        gateway_api_key=API_KEY,
        fly_api_token="test-fly-token",
        fly_org="test-org",
        supabase_url="http://localhost:54321",
        supabase_service_role_key="test-key",
        supabase_jwt_secret=JWT_SECRET,
        openrouter_api_key="test-openrouter-key",
    )


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine.return_value = None
    mock.update_user_machine.return_value = None
    mock.get_app_setting.return_value = None
    mock.set_app_setting.return_value = None
    return mock


def _make_app(mock_supabase, settings):
    app = FastAPI()
    router = create_model_selection_router(
        mock_supabase,
        settings,
        jwt_secret=JWT_SECRET,
        api_key=API_KEY,
    )
    app.include_router(router, prefix="/api")
    return TestClient(app)


# ── GET /api/models ─────────────────────────────────────────


def test_get_models_cmo_plan(mock_supabase, settings):
    """CMO plan: opus not allowed, others allowed."""
    mock_supabase.get_user_machine.return_value = _make_machine(plan="cmo")
    client = _make_app(mock_supabase, settings)

    resp = client.get("/api/models", headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["current"] == "anthropic/claude-opus-4-6"
    assert len(data["models"]) == len(SWITCHABLE_MODELS)

    by_id = {m["id"]: m for m in data["models"]}
    # All models allowed on all tiers
    for m in data["models"]:
        assert m["allowed"] is True


def test_get_models_cmo_plus_plan(mock_supabase, settings):
    """CMO+ plan: all switchable models allowed."""
    mock_supabase.get_user_machine.return_value = _make_machine(plan="cmo_plus")
    client = _make_app(mock_supabase, settings)

    resp = client.get("/api/models", headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"})
    assert resp.status_code == 200
    data = resp.json()
    for m in data["models"]:
        assert m["allowed"] is True


def test_get_models_no_machine(mock_supabase, settings):
    """Returns 404 when user has no machine."""
    client = _make_app(mock_supabase, settings)
    resp = client.get("/api/models", headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"})
    assert resp.status_code == 404


# ── POST /api/models ────────────────────────────────────────


def test_set_model_success(mock_supabase, settings):
    """Successfully switch model."""
    mock_supabase.get_user_machine.return_value = _make_machine(plan="cmo")
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/models",
        json={"model": "google/gemini-3.1-pro-preview"},
        headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "updated"
    assert data["model"] == "google/gemini-3.1-pro-preview"

    mock_supabase.update_user_machine.assert_any_call(
        "machine-1", preferred_model="google/gemini-3.1-pro-preview"
    )


def test_set_model_same_noop(mock_supabase, settings):
    """No-op when setting same model."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        plan="cmo", preferred_model="anthropic/claude-opus-4-6"
    )
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/models",
        json={"model": "anthropic/claude-opus-4-6"},
        headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "unchanged"
    mock_supabase.update_user_machine.assert_not_called()


def test_set_model_cmo_can_use_opus(mock_supabase, settings):
    """CMO plan can use Opus (all models available on all tiers)."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        plan="cmo", preferred_model="anthropic/claude-sonnet-4-6"
    )
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/models",
        json={"model": "anthropic/claude-opus-4-6"},
        headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "updated"


def test_set_model_unknown(mock_supabase, settings):
    """Unknown model returns 400."""
    mock_supabase.get_user_machine.return_value = _make_machine(plan="cmo")
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/models",
        json={"model": "unknown/model"},
        headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
    )
    assert resp.status_code == 400


# ── POST /api/admin/default-model ───────────────────────────


def test_admin_set_default_model(mock_supabase, settings):
    """Admin can set default model."""
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/admin/default-model",
        json={"model": "openai/gpt-5.2"},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    assert resp.status_code == 200
    assert resp.json()["default_model"] == "openai/gpt-5.2"
    mock_supabase.set_app_setting.assert_called_once()


def test_admin_set_default_model_unknown(mock_supabase, settings):
    """Admin cannot set unknown model."""
    client = _make_app(mock_supabase, settings)

    resp = client.post(
        "/api/admin/default-model",
        json={"model": "bad/model"},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    assert resp.status_code == 400


def test_admin_get_default_model(mock_supabase, settings):
    """Admin can read default model."""
    mock_supabase.get_app_setting.return_value = "openai/gpt-5.2"
    client = _make_app(mock_supabase, settings)

    resp = client.get(
        "/api/admin/default-model",
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    assert resp.status_code == 200
    assert resp.json()["default_model"] == "openai/gpt-5.2"


def test_admin_endpoints_require_api_key(mock_supabase, settings):
    """Admin endpoints reject JWT auth."""
    client = _make_app(mock_supabase, settings)

    resp = client.get(
        "/api/admin/default-model",
        headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
    )
    assert resp.status_code == 401
