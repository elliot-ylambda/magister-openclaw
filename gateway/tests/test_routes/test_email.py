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
