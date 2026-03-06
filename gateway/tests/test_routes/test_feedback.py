"""Tests for the /api/feedback route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import jwt as pyjwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.models import MachineStatus, UserMachine
from app.middleware.auth import create_jwt_dependency
from app.routes.feedback import create_feedback_router

JWT_SECRET = "test-jwt-secret"
USER_ID = "user-1"
WEBHOOK_URL = "https://hooks.slack.com/services/T00/B00/xxx"


def _make_machine(**overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id=USER_ID,
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=MachineStatus.running,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        preferred_model="anthropic/claude-opus-4-6",
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


def _make_settings(webhook_url: str = WEBHOOK_URL) -> Settings:
    return Settings(
        port=8080,
        gateway_api_key="test-api-key",
        fly_api_token="test-fly-token",
        fly_org="test-org",
        supabase_url="http://localhost:54321",
        supabase_service_role_key="test-key",
        supabase_jwt_secret=JWT_SECRET,
        openrouter_api_key="test-openrouter-key",
        slack_feedback_webhook_url=webhook_url,
    )


def _make_app(mock_supabase, settings) -> TestClient:
    app = FastAPI()
    verify_jwt = create_jwt_dependency(JWT_SECRET, "http://localhost:54321")
    router = create_feedback_router(mock_supabase, settings, verify_jwt)
    app.include_router(router, prefix="/api")
    return TestClient(app)


FEEDBACK_BODY = {
    "session_id": "sess-123-abcd-efgh",
    "category": "bug",
    "description": "The agent gave a wrong answer",
    "messages": [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ],
}


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine.return_value = _make_machine()
    mock.get_user_profile.return_value = {"id": USER_ID, "email": "test@example.com"}
    return mock


class TestFeedbackSubmission:
    @patch("app.routes.feedback.httpx.AsyncClient")
    def test_success(self, mock_httpx_cls, mock_supabase):
        """Successful feedback submission posts to Slack."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        settings = _make_settings()
        client = _make_app(mock_supabase, settings)

        resp = client.post(
            "/api/feedback",
            json=FEEDBACK_BODY,
            headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        # Verify Slack was called
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args
        assert call_args[0][0] == WEBHOOK_URL
        payload = call_args[1]["json"]
        assert "blocks" in payload

    def test_invalid_category(self, mock_supabase):
        """Invalid category returns 400."""
        settings = _make_settings()
        client = _make_app(mock_supabase, settings)

        body = {**FEEDBACK_BODY, "category": "invalid"}
        resp = client.post(
            "/api/feedback",
            json=body,
            headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
        )
        assert resp.status_code == 400
        assert "Invalid category" in resp.json()["detail"]

    def test_unauthenticated(self, mock_supabase):
        """Missing auth returns 401."""
        settings = _make_settings()
        client = _make_app(mock_supabase, settings)

        resp = client.post("/api/feedback", json=FEEDBACK_BODY)
        assert resp.status_code == 401

    def test_missing_webhook_url(self, mock_supabase):
        """Missing webhook URL returns 503."""
        settings = _make_settings(webhook_url="")
        client = _make_app(mock_supabase, settings)

        resp = client.post(
            "/api/feedback",
            json=FEEDBACK_BODY,
            headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
        )
        assert resp.status_code == 503
        assert "not configured" in resp.json()["detail"]

    @patch("app.routes.feedback.httpx.AsyncClient")
    def test_empty_messages(self, mock_httpx_cls, mock_supabase):
        """Feedback with no messages still works."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        settings = _make_settings()
        client = _make_app(mock_supabase, settings)

        body = {**FEEDBACK_BODY, "messages": []}
        resp = client.post(
            "/api/feedback",
            json=body,
            headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
        )
        assert resp.status_code == 200

    @patch("app.routes.feedback.httpx.AsyncClient")
    def test_all_categories(self, mock_httpx_cls, mock_supabase):
        """All valid categories are accepted."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        settings = _make_settings()
        client = _make_app(mock_supabase, settings)

        for category in ["bug", "wrong_answer", "slow", "other", "contact_support"]:
            body = {**FEEDBACK_BODY, "category": category}
            resp = client.post(
                "/api/feedback",
                json=body,
                headers={"Authorization": f"Bearer {_jwt_for(USER_ID)}"},
            )
            assert resp.status_code == 200
