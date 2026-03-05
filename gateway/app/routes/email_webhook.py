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
