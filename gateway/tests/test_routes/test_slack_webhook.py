"""Tests for the /webhooks/slack route."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.models import MachineStatus, SlackConnection, UserMachine
from app.routes.slack_webhook import create_slack_webhook_router

SIGNING_SECRET = "test-signing-secret-12345"
TEAM_ID = "T12345678"
USER_ID = "user-1"


def _sign_request(body: bytes, secret: str, timestamp: str | None = None) -> tuple[str, str]:
    """Generate Slack-style HMAC-SHA256 signature for a request body."""
    ts = timestamp or str(int(time.time()))
    sig_basestring = f"v0:{ts}:{body.decode('utf-8')}"
    sig = "v0=" + hmac.new(
        secret.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()
    return ts, sig


def _make_settings(**overrides) -> Settings:
    defaults = dict(
        gateway_api_key="test-key",
        fly_api_token="test-fly-token",
        fly_org="test-org",
        supabase_url="http://localhost:54321",
        supabase_service_role_key="test-service-role-key",
        supabase_jwt_secret="test-jwt-secret",
        openrouter_api_key="test-openrouter-key",
        slack_signing_secret=SIGNING_SECRET,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _make_machine(status: MachineStatus = MachineStatus.running, **overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id=USER_ID,
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


def _make_slack_connection(**overrides) -> SlackConnection:
    defaults = dict(
        id="conn-1",
        user_id=USER_ID,
        team_id=TEAM_ID,
        team_name="Test Workspace",
        bot_user_id="U_BOT",
        app_id="A_APP",
        bot_token="xoxb-test-token",
        scope="chat:write",
        status="active",
    )
    defaults.update(overrides)
    return SlackConnection(**defaults)


def _make_event_payload(event_type: str = "message", **overrides) -> dict:
    defaults = dict(
        type="event_callback",
        team_id=TEAM_ID,
        event_id="Ev12345678",
        event={"type": event_type, "text": "hello"},
    )
    defaults.update(overrides)
    return defaults


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_slack_connection_by_team.return_value = None
    mock.get_user_machine.return_value = None
    mock.update_user_machine.return_value = None
    mock.update_last_activity.return_value = None
    mock.revoke_slack_connection.return_value = None
    mock.get_all_slack_connections_for_team.return_value = []
    mock.revoke_all_slack_connections_for_team.return_value = None
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.start_machine.return_value = None
    mock.wait_for_state.return_value = None
    return mock


@pytest.fixture
def settings():
    return _make_settings()


def _make_app(mock_fly, mock_supabase, settings):
    app = FastAPI()
    app.include_router(create_slack_webhook_router(mock_fly, mock_supabase, settings))
    return TestClient(app)


# ── Signature verification ────────────────────────────────────


def test_invalid_signature_rejected(mock_fly, mock_supabase, settings):
    client = _make_app(mock_fly, mock_supabase, settings)
    body = json.dumps({"type": "event_callback"}).encode()
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": str(int(time.time())),
            "x-slack-signature": "v0=invalid",
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 401


def test_expired_timestamp_rejected(mock_fly, mock_supabase, settings):
    client = _make_app(mock_fly, mock_supabase, settings)
    body = json.dumps({"type": "event_callback"}).encode()
    old_ts = str(int(time.time()) - 600)  # 10 minutes ago
    _, sig = _sign_request(body, SIGNING_SECRET, timestamp=old_ts)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": old_ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 401


def test_valid_signature_accepted(mock_fly, mock_supabase, settings):
    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload()
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200


# ── URL verification challenge ────────────────────────────────


def test_url_verification_returns_challenge(mock_fly, mock_supabase, settings):
    client = _make_app(mock_fly, mock_supabase, settings)
    payload = {"type": "url_verification", "challenge": "test-challenge-123"}
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"challenge": "test-challenge-123"}


# ── Dedup ─────────────────────────────────────────────────────


def test_duplicate_event_returns_200(mock_fly, mock_supabase, settings):
    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(event_id="Ev_DUPLICATE")
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    headers = {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
        "content-type": "application/json",
    }

    # First request
    resp1 = client.post("/webhooks/slack", content=body, headers=headers)
    assert resp1.status_code == 200

    # Second request with same event_id — should still 200 but skip processing
    resp2 = client.post("/webhooks/slack", content=body, headers=headers)
    assert resp2.status_code == 200


# ── Missing signing secret ────────────────────────────────────


def test_no_signing_secret_rejects_all(mock_fly, mock_supabase):
    settings = _make_settings(slack_signing_secret="")
    client = _make_app(mock_fly, mock_supabase, settings)
    body = json.dumps({"type": "event_callback"}).encode()
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": str(int(time.time())),
            "x-slack-signature": "v0=anything",
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 401


# ── Event forwarding (integration) ───────────────────────────


def test_forward_schedules_background_task(mock_fly, mock_supabase, settings):
    """Valid event with team_id should trigger background processing."""
    mock_supabase.get_slack_connection_by_team.return_value = _make_slack_connection()
    mock_supabase.get_user_machine.return_value = _make_machine()

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload()
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    # Should ack immediately
    assert resp.status_code == 200


# ── tokens_revoked ────────────────────────────────────────────


def test_tokens_revoked_revokes_connection_and_removes_secrets(
    mock_fly, mock_supabase, settings
):
    """tokens_revoked event should revoke the connection and remove Fly secrets."""
    conn = _make_slack_connection()
    machine = _make_machine()
    mock_supabase.get_slack_connection_by_team.return_value = conn
    mock_supabase.get_user_machine.return_value = machine

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(
        event_type="tokens_revoked",
        event={"type": "tokens_revoked", "tokens": {"bot": ["xoxb-test-token"]}},
    )
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    mock_supabase.get_slack_connection_by_team.assert_called_once_with(TEAM_ID)
    mock_supabase.revoke_slack_connection.assert_called_once_with(USER_ID, TEAM_ID)
    mock_fly.unset_secrets.assert_called_once_with(
        "magister-user1", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]
    )


def test_tokens_revoked_no_connection_is_noop(mock_fly, mock_supabase, settings):
    """tokens_revoked with no active connection should not error."""
    mock_supabase.get_slack_connection_by_team.return_value = None

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(
        event_type="tokens_revoked",
        event={"type": "tokens_revoked", "tokens": {"bot": []}},
    )
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    mock_supabase.revoke_slack_connection.assert_not_called()
    mock_fly.unset_secrets.assert_not_called()


# ── app_uninstalled ───────────────────────────────────────────


def test_app_uninstalled_revokes_all_connections_and_removes_secrets(
    mock_fly, mock_supabase, settings
):
    """app_uninstalled should revoke ALL connections for the team and remove Fly secrets."""
    conn = _make_slack_connection()
    machine = _make_machine()
    mock_supabase.get_all_slack_connections_for_team.return_value = [conn]
    mock_supabase.get_user_machine.return_value = machine

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(
        event_type="app_uninstalled",
        event={"type": "app_uninstalled"},
    )
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    mock_supabase.revoke_all_slack_connections_for_team.assert_called_once_with(TEAM_ID)
    mock_fly.unset_secrets.assert_called_once_with(
        "magister-user1", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]
    )


def test_app_uninstalled_no_connections_is_noop(mock_fly, mock_supabase, settings):
    """app_uninstalled with no connections should not error."""
    mock_supabase.get_all_slack_connections_for_team.return_value = []

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(
        event_type="app_uninstalled",
        event={"type": "app_uninstalled"},
    )
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    mock_supabase.revoke_all_slack_connections_for_team.assert_not_called()
    mock_fly.unset_secrets.assert_not_called()


def test_app_uninstalled_multiple_users(mock_fly, mock_supabase, settings):
    """app_uninstalled with multiple connections should clean up all users' machines."""
    conn1 = _make_slack_connection(id="conn-1", user_id="user-1")
    conn2 = _make_slack_connection(id="conn-2", user_id="user-2")
    machine1 = _make_machine(id="m-1", user_id="user-1", fly_app_name="magister-user1")
    machine2 = _make_machine(id="m-2", user_id="user-2", fly_app_name="magister-user2")

    mock_supabase.get_all_slack_connections_for_team.return_value = [conn1, conn2]
    mock_supabase.get_user_machine.side_effect = [machine1, machine2]

    client = _make_app(mock_fly, mock_supabase, settings)
    payload = _make_event_payload(
        event_type="app_uninstalled",
        event={"type": "app_uninstalled"},
    )
    body = json.dumps(payload).encode()
    ts, sig = _sign_request(body, SIGNING_SECRET)
    resp = client.post(
        "/webhooks/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
            "content-type": "application/json",
        },
    )
    assert resp.status_code == 200
    mock_supabase.revoke_all_slack_connections_for_team.assert_called_once_with(TEAM_ID)
    assert mock_fly.unset_secrets.call_count == 2
