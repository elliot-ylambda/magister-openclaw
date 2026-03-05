# Agent Email System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every AI agent a dedicated email address (`agent-{userId}@agent.magistermarketing.com`) so agents can send and receive emails, with all outbound emails requiring user approval and all inbound emails scanned for malicious content.

**Architecture:** Resend handles SMTP (MX inbound + API outbound). The Gateway is the security boundary -- it receives inbound webhooks, scans content, stores emails in Supabase, and enforces user approval before any outbound send. Agents interact with email via Gateway API endpoints authenticated by machine token.

**Tech Stack:** Resend (email provider), FastAPI (Gateway routes), Supabase (storage + approval state), Python `httpx` (Resend API calls from Gateway -- no new dependencies, httpx is already used)

---

## DNS Prerequisites (Manual, One-Time)

Before any code runs in production:

1. Add subdomain `agent.magistermarketing.com` in your DNS provider
2. In Resend dashboard: add `agent.magistermarketing.com` as a **sending domain** (generates DKIM/SPF/DMARC records to add to DNS)
3. In Resend dashboard: add `agent.magistermarketing.com` as a **receiving domain** (generates MX record to add to DNS)
4. Add MX record to DNS: `agent.magistermarketing.com MX 10 inbound-smtp.resend.com`
5. In Resend dashboard: create webhook pointing to `https://magister-gateway.fly.dev/webhooks/email/inbound` with event type `email.received`
6. Note the **webhook signing secret** from Resend for signature verification

---

## Task 1: Database Migration -- Email Tables

**Files:**
- Create: `webapp/supabase/migrations/20260304200000_create_agent_emails.sql`

**Step 1: Write the migration**

```sql
-- Migration: Create agent email system tables
-- Tables: agent_emails (inbox/outbox), add email_address column to user_machines

-- Add email address to user_machines (assigned at provision time)
ALTER TABLE public.user_machines
ADD COLUMN IF NOT EXISTS email_address TEXT UNIQUE;

-- Agent emails table: stores all inbound and outbound emails
CREATE TABLE public.agent_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES public.user_machines(id) ON DELETE CASCADE,

    -- Direction and status
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',          -- outbound: awaiting user approval
        'approved',         -- outbound: user approved, ready to send
        'sent',             -- outbound: successfully sent via Resend
        'rejected',         -- outbound: user rejected
        'received',         -- inbound: received and stored
        'delivered',        -- inbound: delivered to agent
        'quarantined',      -- inbound: flagged as malicious
        'failed'            -- send failed
    )),

    -- Email fields
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    cc TEXT[],
    bcc TEXT[],
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT,
    body_html TEXT,
    reply_to TEXT,

    -- Threading (RFC 2822)
    message_id TEXT UNIQUE,         -- Message-ID header
    in_reply_to TEXT,               -- In-Reply-To header (parent message_id)
    references_header TEXT,         -- References header (full thread chain)
    thread_id UUID,                 -- Internal thread grouping

    -- Attachments stored as JSONB array
    -- Each: { "filename": "...", "content_type": "...", "size": 123, "storage_path": "..." }
    attachments JSONB DEFAULT '[]'::jsonb,

    -- Metadata
    resend_email_id TEXT,           -- Resend's email ID (for tracking)
    scan_result JSONB,              -- Malicious content scan results
    rejection_reason TEXT,          -- Why user rejected (optional)
    error_message TEXT,             -- If status = 'failed'

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_agent_emails_user_id ON public.agent_emails(user_id);
CREATE INDEX idx_agent_emails_machine_id ON public.agent_emails(machine_id);
CREATE INDEX idx_agent_emails_status ON public.agent_emails(status);
CREATE INDEX idx_agent_emails_direction ON public.agent_emails(direction);
CREATE INDEX idx_agent_emails_thread_id ON public.agent_emails(thread_id);
CREATE INDEX idx_agent_emails_to_address ON public.agent_emails(to_address);
CREATE INDEX idx_agent_emails_message_id ON public.agent_emails(message_id);
CREATE INDEX idx_agent_emails_created_at ON public.agent_emails(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_agent_emails_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_emails_updated_at
    BEFORE UPDATE ON public.agent_emails
    FOR EACH ROW
    EXECUTE FUNCTION public.update_agent_emails_updated_at();

-- RLS
ALTER TABLE public.agent_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own emails"
    ON public.agent_emails FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to agent_emails"
    ON public.agent_emails FOR ALL
    USING (auth.role() = 'service_role');
```

**Step 2: Run migration locally**

Run: `make supabase-migrate`
Expected: Migration applies cleanly

**Step 3: Verify tables exist**

Run: `make connect-local-db` then `\d public.agent_emails` and `\d public.user_machines`
Expected: Both tables show correct columns

**Step 4: Commit**

```bash
git add webapp/supabase/migrations/20260304200000_create_agent_emails.sql
git commit -m "feat(db): add agent_emails table and email_address to user_machines"
```

---

## Task 2: Gateway Config + Pydantic Models

**Files:**
- Modify: `gateway/app/config.py`
- Modify: `gateway/app/models.py`

**Step 1: Write failing test for new config fields**

- Create: `gateway/tests/test_config_email.py`

```python
"""Test that email config fields exist and have correct defaults."""
import pytest
from app.config import Settings


def test_email_config_defaults():
    """Email settings should have sensible defaults."""
    settings = Settings(
        supabase_url="https://test.supabase.co",
        supabase_service_role_key="test-key",
        supabase_jwt_secret="test-jwt",
        fly_api_token="test-fly",
        fly_org="test-org",
        gateway_api_key="test-gw",
    )
    assert settings.resend_api_key == ""
    assert settings.agent_email_domain == "agent.magistermarketing.com"
    assert settings.resend_webhook_secret == ""
```

**Step 2: Run test to verify it fails**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_config_email.py -v`
Expected: FAIL -- `resend_api_key` attribute not found

**Step 3: Add config fields to Settings**

In `gateway/app/config.py`, add to the `Settings` class:

```python
    # Email (Resend)
    resend_api_key: str = ""
    agent_email_domain: str = "agent.magistermarketing.com"
    resend_webhook_secret: str = ""
```

**Step 4: Run test to verify it passes**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_config_email.py -v`
Expected: PASS

**Step 5: Add Pydantic models for email**

In `gateway/app/models.py`, add:

```python
from typing import Literal

class EmailDraftRequest(BaseModel):
    """Agent requests to send an email (requires user approval)."""
    to: str
    subject: str
    body_html: str
    body_text: str | None = None
    cc: list[str] | None = None
    bcc: list[str] | None = None
    reply_to: str | None = None
    in_reply_to: str | None = None          # Message-ID of email being replied to
    attachments: list[dict] | None = None   # [{"filename": "...", "content": "base64...", "content_type": "..."}]


class EmailApprovalRequest(BaseModel):
    """User approves or rejects a pending outbound email."""
    email_id: str
    action: Literal["approve", "reject"]
    rejection_reason: str | None = None
```

**Step 6: Commit**

```bash
git add gateway/app/config.py gateway/app/models.py gateway/tests/test_config_email.py
git commit -m "feat(gateway): add email config settings and Pydantic models"
```

---

## Task 3: Provision Flow -- Auto-Assign Email Address

Moved early because provisioning is the entry point for the whole feature. Email address assignment should happen before building routes that depend on it.

**Files:**
- Modify: `gateway/app/routes/provision.py`

**Step 1: Understand current provision flow**

Read `gateway/app/routes/provision.py` to identify where email assignment fits (after machine creation, during secret setting).

**Step 2: Add email address assignment**

In the provision route, after the DB record is created (Step 0) and before secrets are set (Step 2), generate and store the email address:

```python
    # After machine record creation, generate email address
    # Use first 8 chars of user_id for readability
    email_prefix = f"agent-{user_id[:8]}"
    email_address = f"{email_prefix}@{settings.agent_email_domain}"

    # Handle unlikely collision (first 8 chars of UUID not unique)
    try:
        await supabase.update_user_machine(
            machine.id,
            email_address=email_address,
        )
    except Exception:
        # Fallback to full user_id if short prefix collides
        email_address = f"agent-{user_id}@{settings.agent_email_domain}"
        await supabase.update_user_machine(
            machine.id,
            email_address=email_address,
        )
```

Also add the email address as a secret on the Fly machine so the agent knows its own address:

```python
    # In the secrets dict passed to fly.set_secrets()
    secrets["AGENT_EMAIL_ADDRESS"] = email_address
```

**Step 3: Run provision tests**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_provision.py -v`
Expected: PASS (may need test updates for new secret)

**Step 4: Commit**

```bash
git add gateway/app/routes/provision.py
git commit -m "feat(gateway): auto-assign email address during machine provisioning"
```

---

## Task 4: Supabase Service -- Email Methods

**Files:**
- Modify: `gateway/app/services/supabase_client.py`
- Create: `gateway/tests/test_services/test_email_supabase.py`

**Step 1: Write failing test**

```python
"""Test email-related Supabase service methods."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from app.services.supabase_client import SupabaseService


@pytest.fixture
def mock_supabase():
    """Create a mock SupabaseService with a mocked _client."""
    service = SupabaseService.__new__(SupabaseService)
    service._client = MagicMock()
    return service


@pytest.mark.asyncio
async def test_get_machine_by_email(mock_supabase):
    """Should look up machine by email address."""
    mock_result = MagicMock()
    mock_result.data = {"id": "machine-1", "user_id": "user-1", "email_address": "agent-user1@agent.magistermarketing.com"}

    mock_supabase._client.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute = AsyncMock(return_value=mock_result)

    result = await mock_supabase.get_machine_by_email("agent-user1@agent.magistermarketing.com")
    assert result is not None
    assert result["email_address"] == "agent-user1@agent.magistermarketing.com"


@pytest.mark.asyncio
async def test_create_agent_email(mock_supabase):
    """Should insert an email record."""
    mock_result = MagicMock()
    mock_result.data = [{"id": "email-1", "status": "pending", "direction": "outbound"}]

    mock_supabase._client.table.return_value.insert.return_value.execute = AsyncMock(return_value=mock_result)

    result = await mock_supabase.create_agent_email({
        "user_id": "user-1",
        "machine_id": "machine-1",
        "direction": "outbound",
        "status": "pending",
        "from_address": "agent-user1@agent.magistermarketing.com",
        "to_address": "client@example.com",
        "subject": "Hello",
        "body_html": "<p>Hi</p>",
    })
    assert result["status"] == "pending"


@pytest.mark.asyncio
async def test_update_agent_email_status(mock_supabase):
    """Should update email status."""
    mock_result = MagicMock()
    mock_result.data = [{"id": "email-1", "status": "approved"}]

    mock_supabase._client.table.return_value.update.return_value.eq.return_value.execute = AsyncMock(return_value=mock_result)

    result = await mock_supabase.update_agent_email("email-1", status="approved")
    assert result["status"] == "approved"
```

**Step 2: Run test to verify it fails**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_services/test_email_supabase.py -v`
Expected: FAIL -- methods don't exist

**Step 3: Implement Supabase email methods**

Add to `SupabaseService` in `gateway/app/services/supabase_client.py`:

```python
    async def get_machine_by_email(self, email_address: str) -> dict | None:
        """Look up a user machine by its assigned email address."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("email_address", email_address)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def create_agent_email(self, data: dict) -> dict:
        """Insert a new email record."""
        result = (
            await self._client.table("agent_emails")
            .insert(data)
            .execute()
        )
        return result.data[0]

    async def update_agent_email(self, email_id: str, **updates) -> dict:
        """Update an email record."""
        result = (
            await self._client.table("agent_emails")
            .update(updates)
            .eq("id", email_id)
            .execute()
        )
        return result.data[0]

    async def get_agent_email(self, email_id: str) -> dict | None:
        """Get a single email by ID."""
        result = (
            await self._client.table("agent_emails")
            .select("*")
            .eq("id", email_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_agent_email_by_message_id(self, message_id: str) -> dict | None:
        """Look up an email by its Message-ID header (for threading)."""
        result = (
            await self._client.table("agent_emails")
            .select("*")
            .eq("message_id", message_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_machine_by_token_hash(self, token_hash: str) -> dict | None:
        """Look up machine by gateway token hash."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("gateway_token_hash", token_hash)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_agent_emails(self, user_id: str, direction: str | None = None, status: str | None = None, limit: int = 50) -> list[dict]:
        """List emails for a user, optionally filtered."""
        query = self._client.table("agent_emails").select("*").eq("user_id", user_id)
        if direction:
            query = query.eq("direction", direction)
        if status:
            query = query.eq("status", status)
        result = await query.order("created_at", desc=True).limit(limit).execute()
        return result.data or []

    async def get_pending_outbound_emails(self, user_id: str) -> list[dict]:
        """Get emails awaiting user approval."""
        return await self.get_agent_emails(user_id, direction="outbound", status="pending")
```

**Step 4: Run tests**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_services/test_email_supabase.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add gateway/app/services/supabase_client.py gateway/tests/test_services/test_email_supabase.py
git commit -m "feat(gateway): add email-related Supabase service methods"
```

---

## Task 5: Email Service -- Resend Integration + Content Scanning

**Files:**
- Create: `gateway/app/services/email.py`
- Create: `gateway/tests/test_services/test_email_service.py`

**Step 1: Write failing tests**

```python
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
    """Should call Resend API and return email ID."""
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
    """Clean email should pass scan."""
    result = email_service.scan_inbound_content(
        from_address="client@example.com",
        subject="Meeting tomorrow",
        body_text="Let's meet at 2pm.",
        body_html="<p>Let's meet at 2pm.</p>",
        attachments=[],
    )
    assert result["safe"] is True


def test_scan_content_suspicious_attachment(email_service):
    """Email with executable attachment should be flagged."""
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
    """Email with phishing patterns should be flagged."""
    result = email_service.scan_inbound_content(
        from_address="support@bank.com",
        subject="Urgent: Update your password",
        body_html='<p>Click <a href="http://evil.com/phish">here</a> to verify</p>',
        body_text="Click here to verify",
        attachments=[],
    )
    assert result["safe"] is False
    assert len(result["flags"]) > 0


def test_scan_content_suspicious_html(email_service):
    """Email with javascript: URIs or iframes should be flagged."""
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
    """Should build correct In-Reply-To and References headers."""
    headers = email_service.build_threading_headers(
        in_reply_to="<original-msg-id@example.com>",
        references_chain="<older-msg@example.com> <original-msg-id@example.com>",
    )
    assert headers["In-Reply-To"] == "<original-msg-id@example.com>"
    assert "<older-msg@example.com>" in headers["References"]


def test_build_threading_headers_no_reply(email_service):
    """No in_reply_to should return empty headers."""
    headers = email_service.build_threading_headers()
    assert headers == {}


def test_verify_webhook_signature_valid(email_service):
    """Valid Resend webhook signature should pass."""
    import hmac, hashlib
    payload = b'{"type":"email.received"}'
    secret = "whsec_test"
    timestamp = "1234567890"
    signature = hmac.new(
        secret.encode(), f"{timestamp}.{payload.decode()}".encode(), hashlib.sha256
    ).hexdigest()

    result = email_service.verify_webhook_signature(
        payload=payload,
        signature=f"v1={signature}",
        timestamp=timestamp,
    )
    assert result is True


def test_verify_webhook_signature_invalid(email_service):
    """Invalid signature should fail."""
    result = email_service.verify_webhook_signature(
        payload=b'{"type":"email.received"}',
        signature="v1=invalidsignature",
        timestamp="1234567890",
    )
    assert result is False
```

**Step 2: Run tests to verify they fail**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_services/test_email_service.py -v`
Expected: FAIL -- module doesn't exist

**Step 3: Implement EmailService**

Create `gateway/app/services/email.py`:

```python
"""Email service: Resend integration, content scanning, threading."""
import hashlib
import hmac
import re
import uuid
from datetime import datetime, timezone

import httpx

RESEND_API_URL = "https://api.resend.com"

# Suspicious patterns for inbound scanning
SUSPICIOUS_EXECUTABLE_TYPES = {
    "application/x-msdownload", "application/x-executable",
    "application/x-msdos-program", "application/vnd.microsoft.portable-executable",
    "application/x-sh", "application/x-bat",
}
SUSPICIOUS_EXTENSIONS = {".exe", ".bat", ".cmd", ".scr", ".ps1", ".vbs", ".js", ".msi"}
PHISHING_KEYWORDS = re.compile(
    r"(verify your account|update your password|confirm your identity|"
    r"suspended.*account|urgent.*action|click here immediately)",
    re.IGNORECASE,
)


class EmailService:
    def __init__(self, settings):
        self.api_key = settings.resend_api_key
        self.domain = settings.agent_email_domain
        self.webhook_secret = settings.resend_webhook_secret

    async def send_email(
        self,
        from_address: str,
        to: str,
        subject: str,
        html: str,
        text: str | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to: str | None = None,
        headers: dict | None = None,
        attachments: list[dict] | None = None,
    ) -> str:
        """Send an email via Resend. Returns Resend email ID."""
        payload: dict = {
            "from": from_address,
            "to": [to] if isinstance(to, str) else to,
            "subject": subject,
            "html": html,
        }
        if text:
            payload["text"] = text
        if cc:
            payload["cc"] = cc
        if bcc:
            payload["bcc"] = bcc
        if reply_to:
            payload["reply_to"] = reply_to
        if headers:
            payload["headers"] = headers
        if attachments:
            # Resend expects: [{"filename": "...", "content": "base64..."}]
            payload["attachments"] = attachments

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{RESEND_API_URL}/emails",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
            response.raise_for_status()
            return response.json()["id"]

    def generate_message_id(self) -> str:
        """Generate a unique Message-ID for outbound emails."""
        unique = uuid.uuid4().hex[:16]
        return f"<{unique}@{self.domain}>"

    def build_threading_headers(
        self,
        in_reply_to: str | None = None,
        references_chain: str | None = None,
    ) -> dict:
        """Build RFC 2822 threading headers for email replies."""
        headers = {}
        if in_reply_to:
            headers["In-Reply-To"] = in_reply_to
            if references_chain:
                if not references_chain.strip().endswith(in_reply_to):
                    headers["References"] = f"{references_chain} {in_reply_to}"
                else:
                    headers["References"] = references_chain
            else:
                headers["References"] = in_reply_to
        return headers

    def scan_inbound_content(
        self,
        from_address: str,
        subject: str,
        body_text: str | None,
        body_html: str | None,
        attachments: list[dict],
    ) -> dict:
        """Scan inbound email for malicious content. Returns scan result."""
        flags = []

        # Check attachments for dangerous file types
        for att in attachments:
            content_type = att.get("content_type", "").lower()
            filename = att.get("filename", "").lower()

            if content_type in SUSPICIOUS_EXECUTABLE_TYPES:
                flags.append(f"Suspicious attachment type: {content_type} ({filename})")

            for ext in SUSPICIOUS_EXTENSIONS:
                if filename.endswith(ext):
                    flags.append(f"Dangerous file extension: {filename}")
                    break

        # Check for phishing patterns in subject + body
        text_to_scan = f"{subject} {body_text or ''} {body_html or ''}"
        phishing_matches = PHISHING_KEYWORDS.findall(text_to_scan)
        if phishing_matches:
            flags.append(f"Phishing keywords detected: {', '.join(phishing_matches[:3])}")

        # Check for suspicious HTML (hidden iframes, javascript:, data: URIs)
        if body_html:
            if re.search(r'<iframe', body_html, re.IGNORECASE):
                flags.append("Hidden iframe detected in HTML")
            if re.search(r'javascript:', body_html, re.IGNORECASE):
                flags.append("JavaScript URI detected in HTML")
            if re.search(r'on\w+\s*=', body_html, re.IGNORECASE):
                flags.append("Inline event handler detected in HTML")

        return {
            "safe": len(flags) == 0,
            "flags": flags,
            "scanned_at": datetime.now(timezone.utc).isoformat(),
        }

    def verify_webhook_signature(
        self,
        payload: bytes,
        signature: str,
        timestamp: str,
    ) -> bool:
        """Verify Resend webhook signature (HMAC-SHA256)."""
        if not self.webhook_secret:
            return False

        expected = hmac.new(
            self.webhook_secret.encode(),
            f"{timestamp}.{payload.decode()}".encode(),
            hashlib.sha256,
        ).hexdigest()

        # Signature format: "v1=<hex>"
        provided = signature.replace("v1=", "")
        return hmac.compare_digest(expected, provided)
```

**Step 4: Run tests**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_services/test_email_service.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add gateway/app/services/email.py gateway/tests/test_services/test_email_service.py
git commit -m "feat(gateway): add EmailService with Resend integration and content scanning"
```

---

## Task 6: Gateway Route -- Inbound Email Webhook

**Files:**
- Create: `gateway/app/routes/email_webhook.py`
- Create: `gateway/tests/test_routes/test_email_webhook.py`

**Step 1: Write failing tests**

```python
"""Test inbound email webhook route."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.routes.email_webhook import create_email_webhook_router


def make_app(supabase_overrides=None, scan_result=None):
    """Create test app with configurable mocks."""
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
    """Valid inbound email should be stored and return 200."""
    client = TestClient(make_app())
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "received"


def test_inbound_email_quarantined():
    """Malicious email should be quarantined."""
    app = make_app(scan_result={
        "safe": False,
        "flags": ["Dangerous file extension: invoice.exe"],
        "scanned_at": "2026-03-04T00:00:00Z",
    })
    # Override create_agent_email to return quarantined status
    client = TestClient(app)
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "quarantined"


def test_inbound_unknown_recipient():
    """Email to unknown address should return 404."""
    app = make_app(supabase_overrides={
        "get_machine_by_email": AsyncMock(return_value=None),
    })
    client = TestClient(app)
    response = client.post("/webhooks/email/inbound", json=VALID_PAYLOAD, headers=WEBHOOK_HEADERS)
    assert response.status_code == 404


def test_inbound_non_email_event_ignored():
    """Non email.received events should be ignored."""
    client = TestClient(make_app())
    response = client.post(
        "/webhooks/email/inbound",
        json={"type": "email.delivered", "data": {}},
        headers=WEBHOOK_HEADERS,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
```

**Step 2: Run test to verify it fails**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_email_webhook.py -v`
Expected: FAIL -- module doesn't exist

**Step 3: Implement inbound webhook route**

Create `gateway/app/routes/email_webhook.py`:

```python
"""Inbound email webhook route -- receives emails from Resend."""
import logging
from fastapi import APIRouter, Request, HTTPException

logger = logging.getLogger(__name__)


def create_email_webhook_router(supabase, email_service, settings) -> APIRouter:
    router = APIRouter()

    @router.post("/webhooks/email/inbound")
    async def receive_inbound_email(request: Request):
        """Handle Resend inbound email webhook."""
        body = await request.body()
        payload = await request.json()

        # Verify webhook signature
        svix_id = request.headers.get("svix-id", "")
        svix_timestamp = request.headers.get("svix-timestamp", "")
        svix_signature = request.headers.get("svix-signature", "")

        if settings.resend_webhook_secret:
            if not email_service.verify_webhook_signature(
                payload=body,
                signature=svix_signature,
                timestamp=svix_timestamp,
            ):
                logger.warning("Invalid webhook signature for svix-id=%s", svix_id)
                raise HTTPException(status_code=401, detail="Invalid webhook signature")

        # Only process email.received events
        event_type = payload.get("type")
        if event_type != "email.received":
            return {"status": "ignored", "event_type": event_type}

        data = payload.get("data", {})
        to_addresses = data.get("to", [])
        from_address = data.get("from", "")
        subject = data.get("subject", "")
        body_text = data.get("text", "")
        body_html = data.get("html", "")
        message_id = data.get("message_id", "")
        in_reply_to = data.get("in_reply_to", "")
        references = data.get("references", "")
        attachments = data.get("attachments", [])

        # Find the target agent by to-address
        machine = None
        target_address = None
        for addr in to_addresses:
            machine = await supabase.get_machine_by_email(addr)
            if machine:
                target_address = addr
                break

        if not machine:
            logger.warning("No machine found for addresses: %s", to_addresses)
            raise HTTPException(status_code=404, detail="Unknown recipient")

        # Scan for malicious content
        scan_result = email_service.scan_inbound_content(
            from_address=from_address,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            attachments=attachments,
        )

        status = "received" if scan_result["safe"] else "quarantined"

        # Resolve thread_id: look up by in_reply_to to group into threads
        thread_id = None
        if in_reply_to:
            parent = await supabase.get_agent_email_by_message_id(in_reply_to)
            if parent:
                thread_id = parent.get("thread_id") or parent.get("id")

        # Store email
        email_record = await supabase.create_agent_email({
            "user_id": machine["user_id"],
            "machine_id": machine["id"],
            "direction": "inbound",
            "status": status,
            "from_address": from_address,
            "to_address": target_address,
            "subject": subject,
            "body_text": body_text,
            "body_html": body_html,
            "message_id": message_id,
            "in_reply_to": in_reply_to or None,
            "references_header": references or None,
            "thread_id": thread_id,
            "attachments": attachments,
            "scan_result": scan_result,
        })

        if status == "quarantined":
            logger.warning(
                "Quarantined email %s from %s: %s",
                email_record["id"], from_address, scan_result["flags"],
            )

        logger.info(
            "Inbound email %s from %s to %s (status=%s)",
            email_record["id"], from_address, target_address, status,
        )

        return {"status": status, "email_id": email_record["id"]}

    return router
```

**Step 4: Run tests**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_email_webhook.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add gateway/app/routes/email_webhook.py gateway/tests/test_routes/test_email_webhook.py
git commit -m "feat(gateway): add inbound email webhook route with content scanning"
```

---

## Task 7: Gateway Route -- Outbound Email (Agent Draft + User Approval + Send)

**Files:**
- Create: `gateway/app/routes/email.py`
- Create: `gateway/tests/test_routes/test_email.py`

**Step 1: Write failing tests**

```python
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


@pytest.fixture
def app(supabase, email_service):
    app = FastAPI()
    verify_jwt = MagicMock(return_value="user-1")
    verify_machine_token = MagicMock(return_value="token-hash-1")
    router = create_email_router(supabase, email_service, verify_jwt, verify_machine_token)
    app.include_router(router, prefix="/api")
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_agent_draft_email(client):
    """Agent creates a draft -- should be stored as pending."""
    response = client.post("/api/email/draft", json={
        "to": "client@example.com",
        "subject": "Hello",
        "body_html": "<p>Hi</p>",
    })
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_user_approve_email(client):
    """User approves a pending email -- should send via Resend."""
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 200


def test_user_reject_email(client, supabase):
    """User rejects a pending email -- should update status."""
    supabase.update_agent_email = AsyncMock(return_value={"id": "email-1", "status": "rejected"})
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "reject",
        "rejection_reason": "Not appropriate",
    })
    assert response.status_code == 200


def test_approve_wrong_user(client, supabase):
    """User cannot approve another user's email."""
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "pending", "direction": "outbound",
        "user_id": "other-user",  # Different user
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 403


def test_approve_already_sent(client, supabase):
    """Cannot approve an already-sent email."""
    supabase.get_agent_email = AsyncMock(return_value={
        "id": "email-1", "status": "sent", "direction": "outbound",
        "user_id": "user-1",
    })
    response = client.post("/api/email/approve", json={
        "email_id": "email-1",
        "action": "approve",
    })
    assert response.status_code == 400
```

**Step 2: Run tests to verify they fail**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_email.py -v`
Expected: FAIL

**Step 3: Implement email routes**

Create `gateway/app/routes/email.py`:

```python
"""Email routes: agent drafts, user approval, inbox queries."""
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from app.models import EmailDraftRequest, EmailApprovalRequest

logger = logging.getLogger(__name__)


def create_email_router(supabase, email_service, verify_jwt, verify_machine_token) -> APIRouter:
    router = APIRouter()

    # -- Agent-facing: create draft (machine token auth) --

    @router.post("/email/draft")
    async def create_email_draft(
        request: EmailDraftRequest,
        token_hash: str = Depends(verify_machine_token),
    ):
        """Agent submits an email draft for user approval. NEVER sends directly."""
        machine = await supabase.get_machine_by_token_hash(token_hash)
        if not machine:
            raise HTTPException(status_code=401, detail="Invalid machine token")

        if not machine.get("email_address"):
            raise HTTPException(status_code=400, detail="No email address assigned to this agent")

        message_id = email_service.generate_message_id()

        # Resolve thread
        thread_id = None
        references_header = None
        if request.in_reply_to:
            parent = await supabase.get_agent_email_by_message_id(request.in_reply_to)
            if parent:
                thread_id = parent.get("thread_id") or parent.get("id")
                references_header = parent.get("references_header", "")

        email_record = await supabase.create_agent_email({
            "user_id": machine["user_id"],
            "machine_id": machine["id"],
            "direction": "outbound",
            "status": "pending",
            "from_address": f"Agent <{machine['email_address']}>",
            "to_address": request.to,
            "cc": request.cc,
            "bcc": request.bcc,
            "subject": request.subject,
            "body_html": request.body_html,
            "body_text": request.body_text,
            "reply_to": request.reply_to,
            "message_id": message_id,
            "in_reply_to": request.in_reply_to,
            "references_header": references_header,
            "thread_id": thread_id,
            "attachments": request.attachments,
        })

        logger.info("Email draft %s created (pending approval)", email_record["id"])
        return {"status": "pending", "email_id": email_record["id"]}

    # -- User-facing: approve/reject (JWT auth) --

    @router.post("/email/approve")
    async def approve_or_reject_email(
        request: EmailApprovalRequest,
        user_id: str = Depends(verify_jwt),
    ):
        """User approves or rejects a pending outbound email."""
        email = await supabase.get_agent_email(request.email_id)
        if not email:
            raise HTTPException(status_code=404, detail="Email not found")
        if email["user_id"] != user_id:
            raise HTTPException(status_code=403, detail="Not your email")
        if email["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"Email is {email['status']}, not pending")
        if email["direction"] != "outbound":
            raise HTTPException(status_code=400, detail="Can only approve outbound emails")

        if request.action == "reject":
            await supabase.update_agent_email(
                request.email_id,
                status="rejected",
                rejection_reason=request.rejection_reason,
            )
            logger.info("Email %s rejected by user %s", request.email_id, user_id)
            return {"status": "rejected", "email_id": request.email_id}

        # Build threading headers
        headers = email_service.build_threading_headers(
            in_reply_to=email.get("in_reply_to"),
            references_chain=email.get("references_header"),
        )
        if email.get("message_id"):
            headers["Message-ID"] = email["message_id"]

        # Send via Resend
        try:
            resend_id = await email_service.send_email(
                from_address=email["from_address"],
                to=email["to_address"],
                subject=email["subject"],
                html=email["body_html"],
                text=email.get("body_text"),
                cc=email.get("cc"),
                bcc=email.get("bcc"),
                reply_to=email.get("reply_to"),
                headers=headers if headers else None,
                attachments=email.get("attachments"),
            )
        except Exception as e:
            await supabase.update_agent_email(
                request.email_id,
                status="failed",
                error_message=str(e),
            )
            logger.error("Failed to send email %s: %s", request.email_id, e)
            raise HTTPException(status_code=502, detail="Failed to send email")

        now = datetime.now(timezone.utc).isoformat()
        await supabase.update_agent_email(
            request.email_id,
            status="sent",
            resend_email_id=resend_id,
            approved_at=now,
            sent_at=now,
        )

        logger.info("Email %s approved and sent (resend_id=%s)", request.email_id, resend_id)
        return {"status": "sent", "email_id": request.email_id, "resend_email_id": resend_id}

    # -- User-facing: list emails (JWT auth) --

    @router.get("/email/pending")
    async def list_pending_emails(user_id: str = Depends(verify_jwt)):
        """Get pending outbound emails awaiting approval."""
        emails = await supabase.get_pending_outbound_emails(user_id)
        return {"emails": emails}

    @router.get("/email/inbox")
    async def list_inbox(user_id: str = Depends(verify_jwt)):
        """Get inbound emails for the user's agent."""
        emails = await supabase.get_agent_emails(user_id, direction="inbound")
        return {"emails": emails}

    @router.get("/email/sent")
    async def list_sent(user_id: str = Depends(verify_jwt)):
        """Get sent outbound emails."""
        emails = await supabase.get_agent_emails(user_id, direction="outbound", status="sent")
        return {"emails": emails}

    return router
```

**Step 4: Run tests**

Run: `cd gateway && .venv/bin/python -m pytest tests/test_routes/test_email.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add gateway/app/routes/email.py gateway/tests/test_routes/test_email.py
git commit -m "feat(gateway): add outbound email routes with approval gate"
```

---

## Task 8: Register Routes in Gateway Main

**Files:**
- Modify: `gateway/app/main.py`

**Step 1: Register email routes**

In `gateway/app/main.py`, add imports at top:

```python
from app.routes.email import create_email_router
from app.routes.email_webhook import create_email_webhook_router
from app.services.email import EmailService
```

Inside lifespan, after other service initialization:

```python
    email_service = EmailService(settings)
```

After existing `app.include_router` calls:

```python
    app.include_router(
        create_email_router(supabase, email_service, verify_jwt, verify_machine_token),
        prefix="/api",
    )
    app.include_router(
        create_email_webhook_router(supabase, email_service, settings),
    )
```

**Step 2: Run all gateway tests**

Run: `make gateway-test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add gateway/app/main.py
git commit -m "feat(gateway): register email routes in app startup"
```

---

## Task 9: Pre-PR Check

**Step 1: Run full check**

Run: `make check`
Expected: webapp build + webapp lint + gateway lint all pass

**Step 2: Run all gateway tests**

Run: `make gateway-test`
Expected: All pass

**Step 3: Final commit and push**

```bash
git add -A
git status  # Review all changes
git push origin HEAD
```

---

## Future Tasks (Not in This PR)

These are deferred to follow-up PRs:

1. **Webapp UI**: Email inbox/outbox component, pending approval notifications, approve/reject buttons in chat or settings
2. **OpenClaw email tool**: Add `send_email` and `read_inbox` tools to the agent so it can autonomously draft emails
3. **Real-time notifications**: Push pending email notifications to the webapp via SSE or polling
4. **Attachment storage**: Store large attachments in Supabase Storage instead of inline JSONB
5. **Email quotas**: Per-plan email sending limits enforced at the Gateway
6. **Enhanced scanning**: Integrate with a proper email security API (e.g., VirusTotal for attachments)
7. **User-facing email settings**: Let users customize their agent's display name, signature, auto-reply rules
