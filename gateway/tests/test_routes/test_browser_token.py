"""Tests for browser extension connection token endpoints."""

import pytest
from unittest.mock import AsyncMock
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from app.routes.browser_token import (
    create_browser_token_router,
    _exchange_failures,
    MAX_EXCHANGE_FAILURES,
)


@pytest.fixture
def mock_supabase():
    svc = AsyncMock()
    svc.create_browser_token = AsyncMock(return_value={"id": "tok-1", "token": "abc123"})
    svc.get_browser_token = AsyncMock(return_value={"id": "tok-1", "user_id": "user-1"})
    svc.mark_browser_token_used = AsyncMock()
    return svc


def _make_client(mock_supabase):
    """Build a test app with the browser token router and a fake JWT dependency."""
    app = FastAPI()

    async def fake_jwt():
        return "user-1"

    router = create_browser_token_router(
        mock_supabase,
        Depends(fake_jwt),
        "test-secret",
    )
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_generate_token_returns_token(mock_supabase):
    client = _make_client(mock_supabase)
    resp = client.post("/api/browser/token/generate")
    assert resp.status_code == 200
    data = resp.json()
    assert "token" in data
    assert "expires_at" in data
    mock_supabase.create_browser_token.assert_called_once()


def test_exchange_valid_token_returns_jwt(mock_supabase):
    client = _make_client(mock_supabase)
    resp = client.post("/api/browser/token/exchange", json={"token": "valid-token"})
    assert resp.status_code == 200
    data = resp.json()
    assert "jwt" in data
    mock_supabase.mark_browser_token_used.assert_called_once_with("tok-1")


def test_exchange_invalid_token_returns_401(mock_supabase):
    mock_supabase.get_browser_token = AsyncMock(return_value=None)
    client = _make_client(mock_supabase)
    resp = client.post("/api/browser/token/exchange", json={"token": "bad-token"})
    assert resp.status_code == 401


def test_exchange_rate_limits_after_max_failures(mock_supabase):
    """After MAX_EXCHANGE_FAILURES failed attempts, further requests return 429."""
    _exchange_failures.clear()
    mock_supabase.get_browser_token = AsyncMock(return_value=None)
    client = _make_client(mock_supabase)

    # Exhaust the failure budget
    for _ in range(MAX_EXCHANGE_FAILURES):
        resp = client.post("/api/browser/token/exchange", json={"token": "bad"})
        assert resp.status_code == 401

    # Next attempt should be rate-limited
    resp = client.post("/api/browser/token/exchange", json={"token": "bad"})
    assert resp.status_code == 429
    assert "Too many" in resp.json()["detail"]


def test_exchange_successful_does_not_count_as_failure(mock_supabase):
    """Successful exchanges should not increment the failure counter."""
    _exchange_failures.clear()
    client = _make_client(mock_supabase)

    # Successful exchange
    resp = client.post("/api/browser/token/exchange", json={"token": "valid"})
    assert resp.status_code == 200

    # Failure counter should be empty for this IP
    assert len(_exchange_failures) == 0 or all(
        len(v) == 0 for v in _exchange_failures.values()
    )
