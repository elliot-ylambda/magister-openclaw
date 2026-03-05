"""Tests for BYOK integration in the /llm/v1/chat/completions route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.auth import hash_token
from app.models import MachineStatus, UserApiKey, UserMachine
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


def _make_api_key(provider: str = "anthropic", api_key: str = "sk-ant-test") -> UserApiKey:
    return UserApiKey(
        id="key-1",
        user_id="user-1",
        provider=provider,
        api_key=api_key,
        key_suffix=api_key[-4:],
        status="active",
    )


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine_by_token_hash.return_value = None
    mock.get_monthly_llm_spend.return_value = 0
    mock.insert_usage_event.return_value = None
    mock.get_user_api_keys.return_value = []
    return mock


@pytest.fixture
def mock_llm():
    mock = AsyncMock(spec=LLMService)
    mock.validate_model.return_value = True
    mock.check_budget = AsyncMock(return_value=True)
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


def _llm_request(model="anthropic/claude-sonnet-4-6"):
    return {
        "model": model,
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": False,
    }


def test_byok_skips_model_validation(mock_llm, mock_supabase):
    """BYOK request should bypass model allowlist — disallowed model succeeds."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = [_make_api_key()]
    mock_llm.validate_model.return_value = False  # Would normally block

    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 200
    # validate_model should NOT have been called since BYOK skips it
    mock_llm.validate_model.assert_not_called()


def test_byok_skips_budget_check(mock_llm, mock_supabase):
    """BYOK request should bypass budget check — over-budget user succeeds."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = [_make_api_key()]
    mock_llm.check_budget = AsyncMock(return_value=False)  # Would normally block

    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 200
    mock_llm.check_budget.assert_not_called()


def test_byok_passes_keys_to_completion(mock_llm, mock_supabase):
    """BYOK keys should be forwarded to llm.completion()."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = [_make_api_key("anthropic", "sk-ant-12345")]

    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 200
    call_kwargs = mock_llm.completion.call_args
    assert call_kwargs.kwargs["byok_keys"] == {"anthropic": "sk-ant-12345"}


def test_byok_invalid_key_does_not_fallback(mock_llm, mock_supabase):
    """Bad BYOK key should raise error, NOT fall back to platform key."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = [_make_api_key("anthropic", "sk-invalid")]
    mock_llm.completion = AsyncMock(side_effect=Exception("Invalid API key"))

    client = _make_app(mock_llm, mock_supabase)
    with pytest.raises(Exception, match="Invalid API key"):
        client.post(
            "/llm/v1/chat/completions",
            json=_llm_request(),
            headers={"Authorization": "Bearer test-token"},
        )
    # completion was called exactly once — no retry with platform key
    mock_llm.completion.assert_called_once()


def test_no_byok_still_validates(mock_llm, mock_supabase):
    """Without BYOK keys, normal model validation and budget checks apply."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = []  # No BYOK keys
    mock_llm.validate_model.return_value = False

    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(model="anthropic/claude-opus-4-6"),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 403
    mock_llm.validate_model.assert_called_once()


def test_no_byok_budget_exceeded(mock_llm, mock_supabase):
    """Without BYOK keys, budget check still blocks over-budget users."""
    mock_supabase.get_user_machine_by_token_hash.return_value = _make_machine()
    mock_supabase.get_user_api_keys.return_value = []
    mock_llm.check_budget = AsyncMock(return_value=False)

    client = _make_app(mock_llm, mock_supabase)
    resp = client.post(
        "/llm/v1/chat/completions",
        json=_llm_request(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert resp.status_code == 402
