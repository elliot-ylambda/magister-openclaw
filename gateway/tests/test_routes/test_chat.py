"""Tests for the /api/chat route."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.rate_limit import RateLimiter
from app.models import MachineStatus, UserMachine
from app.routes.chat import create_chat_router


def _make_machine(status: MachineStatus = MachineStatus.running, **overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id="user-1",
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=status,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        current_image="registry.fly.io/openclaw:latest",
        provisioning_step=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine.return_value = None
    mock.update_user_machine.return_value = None
    mock.update_last_activity.return_value = None
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.start_machine.return_value = None
    mock.wait_for_state.return_value = None
    return mock


@pytest.fixture
def rate_limiter():
    return RateLimiter(max_requests=20, window_seconds=60.0)


def _make_app(mock_fly, mock_supabase, rate_limiter):
    """Create a test app with the chat router, bypassing JWT auth."""
    from fastapi import Depends

    app = FastAPI()

    # Stub JWT dependency that always returns "user-1"
    async def fake_jwt():
        return "user-1"

    verify_jwt = Depends(fake_jwt)

    app.include_router(
        create_chat_router(mock_fly, mock_supabase, rate_limiter, verify_jwt),
        prefix="/api",
    )
    return TestClient(app)


def test_chat_no_machine(mock_fly, mock_supabase, rate_limiter):
    mock_supabase.get_user_machine.return_value = None
    client = _make_app(mock_fly, mock_supabase, rate_limiter)
    resp = client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 404


def test_chat_provisioning(mock_fly, mock_supabase, rate_limiter):
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning
    )
    client = _make_app(mock_fly, mock_supabase, rate_limiter)
    resp = client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 503


def test_chat_destroyed(mock_fly, mock_supabase, rate_limiter):
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.destroyed
    )
    client = _make_app(mock_fly, mock_supabase, rate_limiter)
    resp = client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 410


def test_chat_failed(mock_fly, mock_supabase, rate_limiter):
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.failed
    )
    client = _make_app(mock_fly, mock_supabase, rate_limiter)
    resp = client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 500


def test_chat_rate_limited(mock_fly, mock_supabase):
    limiter = RateLimiter(max_requests=1, window_seconds=60.0)
    mock_supabase.get_user_machine.return_value = _make_machine()
    client = _make_app(mock_fly, mock_supabase, limiter)

    # First request consumes the single token — it will try to proceed
    # (and hit health check which we don't mock, so it may fail for other reasons)
    # But the second request should get 429
    with patch("app.routes.chat.httpx.AsyncClient") as mock_httpx:
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)
        mock_resp.raise_for_status = AsyncMock()
        mock_httpx.return_value = mock_resp
        mock_resp.get = AsyncMock(return_value=mock_resp)

        client.post("/api/chat", json={"message": "first"})
    resp = client.post("/api/chat", json={"message": "second"})
    assert resp.status_code == 429


def test_chat_non_streaming(mock_fly, mock_supabase, rate_limiter):
    """stream=false returns a single JSON response with concatenated content."""
    mock_supabase.get_user_machine.return_value = _make_machine()
    client = _make_app(mock_fly, mock_supabase, rate_limiter)

    async def _fake_lines():
        for line in ["Hello ", "world"]:
            yield line

    with patch("app.routes.chat.httpx.AsyncClient") as mock_httpx:
        # Health-check response
        hc_resp = MagicMock()
        hc_resp.raise_for_status = MagicMock()

        # Streaming response (async context manager for client.stream())
        stream_resp = AsyncMock()
        stream_resp.status_code = 200
        stream_resp.aiter_lines = _fake_lines
        stream_resp.__aenter__ = AsyncMock(return_value=stream_resp)
        stream_resp.__aexit__ = AsyncMock(return_value=False)

        # First AsyncClient() → health check
        hc_client = AsyncMock()
        hc_client.get = AsyncMock(return_value=hc_resp)
        ctx1 = AsyncMock()
        ctx1.__aenter__ = AsyncMock(return_value=hc_client)
        ctx1.__aexit__ = AsyncMock(return_value=False)

        # Second AsyncClient() → streaming
        stream_client = AsyncMock()
        stream_client.stream = MagicMock(return_value=stream_resp)
        ctx2 = AsyncMock()
        ctx2.__aenter__ = AsyncMock(return_value=stream_client)
        ctx2.__aexit__ = AsyncMock(return_value=False)

        mock_httpx.side_effect = [ctx1, ctx2]

        resp = client.post("/api/chat", json={"message": "hello", "stream": False})

    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == "Hello world"
    assert data["session_id"] is None


def test_chat_concurrent_request(mock_fly, mock_supabase, rate_limiter):
    """Manually test the concurrency lock by injecting a user into _active_requests."""
    from app.routes.chat import _active_requests

    mock_supabase.get_user_machine.return_value = _make_machine()
    client = _make_app(mock_fly, mock_supabase, rate_limiter)

    _active_requests.add("user-1")
    try:
        resp = client.post("/api/chat", json={"message": "hello"})
        assert resp.status_code == 409
    finally:
        _active_requests.discard("user-1")
