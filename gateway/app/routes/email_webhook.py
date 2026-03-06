"""Inbound email webhook route -- receives emails from Resend."""
import asyncio
import logging
import httpx
from fastapi import APIRouter, BackgroundTasks, Request, HTTPException
from svix.webhooks import WebhookVerificationError

logger = logging.getLogger(__name__)

WAKE_TIMEOUT_S = 45


def create_email_webhook_router(supabase, email_service, settings, fly) -> APIRouter:
    router = APIRouter()

    def _machine_url(machine: dict) -> str:
        if settings.dev_machine_url:
            return settings.dev_machine_url
        return f"http://{machine['fly_machine_id']}.vm.{machine['fly_app_name']}.internal:18790"

    async def _forward_email_to_agent(email_record: dict, machine: dict) -> None:
        """Forward inbound email to agent's OpenClaw machine as a chat message."""
        try:
            status = machine.get("status", "")
            if status in ("destroyed", "failed", "provisioning", "destroying"):
                logger.warning("[email] machine %s in non-routable state: %s", machine["id"], status)
                return

            # Wake if suspended
            if status == "suspended" and not settings.dev_machine_url:
                try:
                    await fly.start_machine(machine["fly_app_name"], machine["fly_machine_id"])
                    await fly.wait_for_state(
                        machine["fly_app_name"], machine["fly_machine_id"],
                        "started", timeout_s=WAKE_TIMEOUT_S,
                    )
                    base = _machine_url(machine)
                    for _ in range(12):
                        try:
                            async with httpx.AsyncClient(timeout=5.0) as hc:
                                resp = await hc.get(f"{base}/health")
                                resp.raise_for_status()
                            break
                        except Exception:
                            await asyncio.sleep(5)
                    else:
                        raise TimeoutError("OpenClaw health check never passed")
                    logger.info("[email] woke machine %s for email forwarding", machine["id"])
                except Exception:
                    logger.exception("[email] failed to wake machine %s", machine["id"])
                    return

            # Send chat message to OpenClaw
            base_url = _machine_url(machine)
            from_addr = email_record.get("from_address", "unknown")
            subject = email_record.get("subject", "(no subject)")
            body_text = email_record.get("body_text", "")
            email_id = email_record.get("id", "")

            content = (
                f"New inbound email received:\n"
                f"From: {from_addr}\n"
                f"Subject: {subject}\n\n"
                f"{body_text}\n\n"
                f"[Email ID: {email_id}]\n\n"
                f"You can read the full email with: GET /api/email/agent/{email_id}\n"
                f"To reply, use POST /api/email/draft with in_reply_to set to the original message_id."
            )

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {machine['gateway_token']}",
            }

            last_exc = None
            for attempt in range(4):
                try:
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        resp = await client.post(
                            f"{base_url}/v1/chat/completions",
                            json={
                                "model": "openclaw",
                                "messages": [{"role": "user", "content": content}],
                                "stream": False,
                            },
                            headers=headers,
                        )
                        if resp.status_code >= 400:
                            logger.warning(
                                "[email] OpenClaw returned %d for email forward: %s",
                                resp.status_code, resp.text[:200],
                            )
                        last_exc = None
                        break
                except (httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                    last_exc = exc
                    if attempt < 3:
                        await asyncio.sleep(5)

            if last_exc:
                logger.error("[email] failed to forward to machine %s: %s", machine["id"], last_exc)

            await supabase.update_last_activity(machine["user_id"])

        except Exception:
            logger.exception("[email] error forwarding email %s", email_record.get("id"))

    @router.post("/webhooks/email/inbound")
    async def receive_inbound_email(request: Request, background_tasks: BackgroundTasks):
        """Handle Resend inbound email webhook."""
        body = await request.body()

        # Verify webhook signature using Svix
        if settings.resend_webhook_secret:
            headers = {
                "svix-id": request.headers.get("svix-id", ""),
                "svix-timestamp": request.headers.get("svix-timestamp", ""),
                "svix-signature": request.headers.get("svix-signature", ""),
            }
            try:
                payload = email_service.verify_webhook(body, headers)
            except WebhookVerificationError:
                logger.warning("Invalid webhook signature for svix-id=%s", headers["svix-id"])
                raise HTTPException(status_code=401, detail="Invalid webhook signature")
        else:
            payload = await request.json()

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

        # Forward received (non-quarantined) emails to the agent
        if status == "received":
            background_tasks.add_task(_forward_email_to_agent, email_record, machine)

        return {"status": status, "email_id": email_record["id"]}

    return router
