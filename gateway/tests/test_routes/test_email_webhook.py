"""Test inbound email webhook route."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.routes.email_webhook import create_email_webhook_router


def make_app(supabase_overrides=None, scan_result=None):
    app = FastAPI()
    supabase = MagicMock()
    email_service = MagicMock()
    settings = MagicMock()
    settings.resend_webhook_secret = "whsec_test"

    supabase.get_machine_by_email = AsyncMock(return_value={
        "id": "machine-1",
        "user_id": "user-1",
        "email_address": "agent-user1@agent.magistermarketing.com",
        "fly_app_name": "magister-user1",
    })
    supabase.create_agent_email = AsyncMock(return_value={
        "id": "email-1",
        "status": "received",
        "direction": "inbound",
    })
    supabase.get_agent_email_by_message_id = AsyncMock(return_value=None)

    if supabase_overrides:
        for key, value in supabase_overrides.items():
            setattr(supabase, key, value)

    email_service.scan_inbound_content = MagicMock(
        return_value=scan_result or {"safe": True, "flags": [], "scanned_at": "2026-03-04T00:00:00Z"}
    )
    email_service.verify_webhook_signature = MagicMock(return_value=True)

    router = create_email_webhook_router(supabase, email_service, settings)
    app.include_router(router)
    return app


VALID_PAYLOAD = {
    "type": "email.received",
    "data": {
        "from": "sender@example.com",
        "to": ["agent-user1@agent.magistermarketing.com"],
        "subject": "Hello Agent",
        "text": "Can you help me?",
        "html": "<p>Can you help me?</p>",
        "message_id": "<msg-123@example.com>",
        "attachments": [],
    }
}

WEBHOOK_HEADERS = {
    "svix-id": "msg_test",
    "svix-timestamp": "1234567890",
    "svix-signature": "v1=test",
}


def test_inbound_email_received():
    client = TestClient(make_app())
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "received"


def test_inbound_email_quarantined():
    app = make_app(scan_result={
        "safe": False,
        "flags": ["Dangerous file extension: invoice.exe"],
        "scanned_at": "2026-03-04T00:00:00Z",
    })
    client = TestClient(app)
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "quarantined"


def test_inbound_unknown_recipient():
    app = make_app(supabase_overrides={
        "get_machine_by_email": AsyncMock(return_value=None),
    })
    client = TestClient(app)
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 404


def test_inbound_non_email_event_ignored():
    client = TestClient(make_app())
    response = client.post(
        "/webhooks/email/inbound",
        json={"type": "email.delivered", "data": {}},
        headers=WEBHOOK_HEADERS,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
