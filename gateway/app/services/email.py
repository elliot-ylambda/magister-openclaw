"""Email service: Resend integration, content scanning, threading."""
import re
import uuid
from datetime import datetime, timezone

import httpx
from svix.webhooks import Webhook, WebhookVerificationError

RESEND_API_URL = "https://api.resend.com"

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
        unique = uuid.uuid4().hex[:16]
        return f"<{unique}@{self.domain}>"

    def build_threading_headers(
        self,
        in_reply_to: str | None = None,
        references_chain: str | None = None,
    ) -> dict:
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
        flags = []

        for att in attachments:
            content_type = att.get("content_type", "").lower()
            filename = att.get("filename", "").lower()
            if content_type in SUSPICIOUS_EXECUTABLE_TYPES:
                flags.append(f"Suspicious attachment type: {content_type} ({filename})")
            for ext in SUSPICIOUS_EXTENSIONS:
                if filename.endswith(ext):
                    flags.append(f"Dangerous file extension: {filename}")
                    break

        text_to_scan = f"{subject} {body_text or ''} {body_html or ''}"
        phishing_matches = PHISHING_KEYWORDS.findall(text_to_scan)
        if phishing_matches:
            flags.append(f"Phishing keywords detected: {', '.join(phishing_matches[:3])}")

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

    def verify_webhook(self, payload: bytes, headers: dict) -> dict:
        """Verify a Svix webhook signature and return the parsed payload.

        Raises WebhookVerificationError if invalid.
        """
        wh = Webhook(self.webhook_secret)
        return wh.verify(payload, headers)
