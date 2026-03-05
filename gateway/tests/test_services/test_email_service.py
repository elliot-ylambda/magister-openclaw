"""Test EmailService -- Resend sending, content scanning, threading."""
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from app.services.email import EmailService


@pytest.fixture
def email_service():
    settings = MagicMock()
    settings.resend_api_key = "re_test_key"
    settings.agent_email_domain = "agent.magistermarketing.com"
    settings.resend_webhook_secret = "whsec_test"
    return EmailService(settings)


@pytest.mark.asyncio
async def test_send_email(email_service):
    with patch("httpx.AsyncClient.post") as mock_post:
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"id": "resend-email-123"}
        )
        result = await email_service.send_email(
            from_address="Agent <agent-user1@agent.magistermarketing.com>",
            to="client@example.com",
            subject="Hello",
            html="<p>Hi there</p>",
        )
        assert result == "resend-email-123"


def test_scan_content_clean(email_service):
    result = email_service.scan_inbound_content(
        from_address="client@example.com",
        subject="Meeting tomorrow",
        body_text="Let's meet at 2pm.",
        body_html="<p>Let's meet at 2pm.</p>",
        attachments=[],
    )
    assert result["safe"] is True


def test_scan_content_suspicious_attachment(email_service):
    result = email_service.scan_inbound_content(
        from_address="attacker@evil.com",
        subject="Invoice attached",
        body_html="<p>See attached</p>",
        body_text="See attached",
        attachments=[{"filename": "invoice.exe", "content_type": "application/x-msdownload", "size": 1024}],
    )
    assert result["safe"] is False
    assert any("exe" in f.lower() for f in result["flags"])


def test_scan_content_phishing_keywords(email_service):
    result = email_service.scan_inbound_content(
        from_address="support@bank.com",
        subject="Urgent: Update your password",
        body_html='<p>Click here to verify</p>',
        body_text="Click here to verify",
        attachments=[],
    )
    assert result["safe"] is False


def test_scan_content_suspicious_html(email_service):
    result = email_service.scan_inbound_content(
        from_address="someone@example.com",
        subject="Check this out",
        body_html='<iframe src="http://evil.com"></iframe><a href="javascript:alert(1)">click</a>',
        body_text="",
        attachments=[],
    )
    assert result["safe"] is False
    assert len(result["flags"]) >= 2


def test_build_threading_headers(email_service):
    headers = email_service.build_threading_headers(
        in_reply_to="<original-msg-id@example.com>",
        references_chain="<older-msg@example.com> <original-msg-id@example.com>",
    )
    assert headers["In-Reply-To"] == "<original-msg-id@example.com>"
    assert "<older-msg@example.com>" in headers["References"]


def test_build_threading_headers_no_reply(email_service):
    headers = email_service.build_threading_headers()
    assert headers == {}


def test_verify_webhook_signature_valid(email_service):
    import hmac, hashlib
    payload = b'{"type":"email.received"}'
    timestamp = "1234567890"
    signature = hmac.new(
        "whsec_test".encode(), f"{timestamp}.{payload.decode()}".encode(), hashlib.sha256
    ).hexdigest()
    result = email_service.verify_webhook_signature(
        payload=payload, signature=f"v1={signature}", timestamp=timestamp,
    )
    assert result is True


def test_verify_webhook_signature_invalid(email_service):
    result = email_service.verify_webhook_signature(
        payload=b'{"type":"email.received"}',
        signature="v1=invalidsignature",
        timestamp="1234567890",
    )
    assert result is False
