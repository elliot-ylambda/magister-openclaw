"""Test outbound email routes: draft, approve, reject, list."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.routes.email import create_email_router


@pytest.fixture
def supabase():
    s = MagicMock()
    s.get_machine_by_token_hash = AsyncMock(return_value={
        "id": "machine-1",
        "user_id": "user-1",
        "email_address": "agent-user1@agent.magistermarketing.com",
    })
    s.create_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "pending", "direction": "outbound",
    })
    s.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "pending", "direction": "outbound",
        "user_id": "user-1", "machine_id": "machine-1",
        "from_address": "agent-user1@agent.magistermarketing.com",
        "to_address": "client@example.com",
        "subject": "Hello", "body_html": "<p>Hi</p>",
        "in_reply_to": None, "references_header": None,
    })
    s.update_agent_email = AsyncMock(return_value={"id": "email-1", "status": "approved"})
    s.get_pending_outbound_emails = AsyncMock(return_value=[])
    s.get_agent_emails = AsyncMock(return_value=[])
    s.get_agent_email_by_message_id = AsyncMock(return_value=None)
    s.get_actionable_outbound_emails = AsyncMock(return_value=[])
    return s


@pytest.fixture
def email_service():
    es = MagicMock()
    es.send_email = AsyncMock(return_value="resend-id-123")
    es.generate_message_id = MagicMock(return_value="<abc@agent.magistermarketing.com>")
    es.build_threading_headers = MagicMock(return_value={})
    return es


def mock_verify_jwt():
    return "user-1"


def mock_verify_machine_token():
    return "token-hash-1"


@pytest.fixture
def app(supabase, email_service):
    app = FastAPI()
    router = create_email_router(supabase, email_service, mock_verify_jwt, mock_verify_machine_token)
    app.include_router(router, prefix="/api")
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_agent_draft_email(client):
    response = client.post("/api/email/draft", json={
        "to": "client@example.com",
        "subject": "Hello",
        "body_html": "<p>Hi</p>",
    })
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_user_approve_email(client):
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 200


def test_user_reject_email(client, supabase):
    supabase.update_agent_email = AsyncMock(return_value={"id": "email-1", "status": "rejected"})
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "reject",
        "rejection_reason": "Not appropriate",
    })
    assert response.status_code == 200


def test_approve_wrong_user(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "pending", "direction": "outbound",
        "user_id": "other-user",
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 403


def test_approve_already_sent(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "sent", "direction": "outbound",
        "user_id": "user-1",
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 400


def test_rewrite_email_sets_status_and_note(client, supabase):
    supabase.update_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "rewrite_requested",
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "rewrite",
        "rewrite_note": "Make it more formal",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "rewrite_requested"
    assert data["email_id"] == "email-1"
    supabase.update_agent_email.assert_called_once_with(
        "email-1",
        status="rewrite_requested",
        rewrite_note="Make it more formal",
    )


def test_edit_email_updates_content_and_sends(client, supabase, email_service):
    # After the edit updates, re-fetch returns updated content
    supabase.get_agent_email = AsyncMock(side_effect=[
        # First call: initial fetch (pending check)
        {
            "id": "email-1", "status": "pending", "direction": "outbound",
            "user_id": "user-1", "machine_id": "machine-1",
            "from_address": "agent-user1@agent.magistermarketing.com",
            "to_address": "client@example.com",
            "subject": "Updated Subject", "body_html": "<p>Updated body</p>",
            "in_reply_to": None, "references_header": None,
        },
        # Second call: re-fetch after edit
        {
            "id": "email-1", "status": "pending", "direction": "outbound",
            "user_id": "user-1", "machine_id": "machine-1",
            "from_address": "agent-user1@agent.magistermarketing.com",
            "to_address": "client@example.com",
            "subject": "Updated Subject", "body_html": "<p>Updated body</p>",
            "in_reply_to": None, "references_header": None,
        },
    ])
    supabase.update_agent_email = AsyncMock(return_value={"id": "email-1", "status": "sent"})
    email_service.send_email = AsyncMock(return_value="resend-edit-123")

    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "edit",
        "edited_subject": "Updated Subject",
        "edited_body_html": "<p>Updated body</p>",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "sent"
    assert data["resend_email_id"] == "resend-edit-123"

    # Verify the content was updated before sending
    update_calls = supabase.update_agent_email.call_args_list
    # First call should update content fields
    assert update_calls[0].kwargs["subject"] == "Updated Subject"
    assert update_calls[0].kwargs["body_html"] == "<p>Updated body</p>"

    # Verify send used updated content
    email_service.send_email.assert_called_once()
    send_kwargs = email_service.send_email.call_args
    assert send_kwargs.kwargs["subject"] == "Updated Subject"
    assert send_kwargs.kwargs["html"] == "<p>Updated body</p>"


def test_rewrite_requires_pending_status(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "sent", "direction": "outbound",
        "user_id": "user-1",
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "rewrite",
        "rewrite_note": "Make it shorter",
    })
    assert response.status_code == 400


# ── Agent-facing endpoint tests ──────────────────────────────


def test_agent_inbox(client, supabase):
    supabase.get_agent_emails = AsyncMock(return_value=[
        {"id": "e1", "direction": "inbound", "from_address": "sender@example.com"},
    ])
    response = client.get("/api/email/agent/inbox")
    assert response.status_code == 200
    assert len(response.json()["emails"]) == 1
    supabase.get_agent_emails.assert_called_once_with(
        "user-1", direction="inbound", since=None, limit=50,
    )


def test_agent_inbox_with_since(client, supabase):
    response = client.get("/api/email/agent/inbox?since=2026-03-01T00:00:00Z")
    assert response.status_code == 200
    supabase.get_agent_emails.assert_called_once_with(
        "user-1", direction="inbound", since="2026-03-01T00:00:00Z", limit=50,
    )


def test_agent_sent(client, supabase):
    response = client.get("/api/email/agent/sent")
    assert response.status_code == 200
    supabase.get_agent_emails.assert_called_once_with(
        "user-1", direction="outbound", status="sent", since=None, limit=50,
    )


def test_agent_pending(client, supabase):
    response = client.get("/api/email/agent/pending")
    assert response.status_code == 200
    supabase.get_actionable_outbound_emails.assert_called_once_with("user-1")


def test_agent_get_email_by_id(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "user_id": "user-1", "subject": "Test",
    })
    response = client.get("/api/email/agent/email-1")
    assert response.status_code == 200
    assert response.json()["email"]["subject"] == "Test"


def test_agent_get_email_wrong_user(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "user_id": "other-user",
    })
    response = client.get("/api/email/agent/email-1")
    assert response.status_code == 403


def test_agent_get_email_not_found(client, supabase):
    supabase.get_agent_email = AsyncMock(return_value=None)
    response = client.get("/api/email/agent/email-1")
    assert response.status_code == 404
