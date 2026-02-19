"""Tests for the /llm/v1/chat/completions route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.auth import hash_token
from app.models import MachineStatus, UserMachine
from app.routes.llm_proxy import create_llm_proxy_router
from app.services.llm import LLMService


def _make_machine(**overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id="user-1",
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=MachineStatus.running,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash=hash_token("test-token"),
        current_image="registry.fly.io/openclaw:test",
        provisioning_step=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine_by_token_hash.return_value = None
    mock.get_monthly_llm_spend.return_value = 0
    mock.insert_usage_event.return_value = None
    return mock


@pytest.fixture
def mock_llm():
    mock = AsyncMock(spec=LLMService)
    mock.validate_model.return_value = True
    mock.check_budget = AsyncMock(return_value=True)
    # Non-streaming response mock
    mock_response = MagicMock()
    mock_response.model_dump.return_value = {
        "id": "test",
        "choices": [{"message": {"content": "Hello"}}],
    }
    mock.completion = AsyncMock(return_value=mock_response)
    return mock


def _make_app(mock_llm, mock_supabase):
    app = FastAPI()
    app.include_router(
        create_llm_proxy_router(mock_llm, mock_supabase),
        prefix="/llm",
    )
    return TestClient(app)


def _llm_request(model="claude-sonnet-4-6"):
    return {
        "model": model,
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": False,
    }


def test_llm_proxy_unknown_token(mock_llm, mock_supabase):
    """Returns 401 for unknown machine token."""
    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer unknown-token"},
    )
    assert resp.status_code == 401


def test_llm_proxy_missing_auth(mock_llm, mock_supabase):
    """Returns 401 for missing Authorization header."""
    client = _make_app(mock_llm, mock_supabase)
    resp = client.post("/llm/v1/chat/completions", json=_llm_request())
    assert resp.status_code == 401


def test_llm_proxy_model_not_allowed(mock_llm, mock_supabase):
    """Returns 403 when model is not in plan allowlist."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_llm.validate_model.return_value = False
    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(model="claude-opus-4-6"),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 403


def test_llm_proxy_budget_exceeded(mock_llm, mock_supabase):
    """Returns 402 when monthly budget is exceeded."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_llm.check_budget = AsyncMock(return_value=False)
    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 402


def test_llm_proxy_non_streaming_success(mock_llm, mock_supabase):
    """Returns LLM response for non-streaming request."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 200
    assert "choices" in resp.json()
    mock_llm.completion.assert_called_once()
