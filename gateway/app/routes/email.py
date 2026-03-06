"""Email routes: agent drafts, user approval, inbox queries."""
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from app.models import EmailDraftRequest, EmailApprovalRequest

logger = logging.getLogger(__name__)


def create_email_router(supabase, email_service, verify_jwt, verify_machine_token) -> APIRouter:
    router = APIRouter()

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

    @router.post("/email/approve")
    async def approve_or_reject_email(
        request: EmailApprovalRequest,
        user_id: str = verify_jwt,
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

        if request.action == "rewrite":
            await supabase.update_agent_email(
                request.email_id,
                status="rewrite_requested",
                rewrite_note=request.rewrite_note,
            )
            logger.info("Email %s rewrite requested by user %s", request.email_id, user_id)
            return {"status": "rewrite_requested", "email_id": request.email_id}

        # For "edit" action, apply user edits before sending
        if request.action == "edit":
            updates: dict = {}
            if request.edited_subject is not None:
                updates["subject"] = request.edited_subject
            if request.edited_body_html is not None:
                updates["body_html"] = request.edited_body_html
            if request.edited_body_text is not None:
                updates["body_text"] = request.edited_body_text
            if updates:
                await supabase.update_agent_email(request.email_id, **updates)
                # Re-fetch email with updated content
                email = await supabase.get_agent_email(request.email_id)

        # Build threading headers (shared by approve + edit)
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

    @router.get("/email/pending")
    async def list_pending_emails(user_id: str = verify_jwt):
        emails = await supabase.get_pending_outbound_emails(user_id)
        return {"emails": emails}

    @router.get("/email/inbox")
    async def list_inbox(user_id: str = verify_jwt):
        emails = await supabase.get_agent_emails(user_id, direction="inbound")
        return {"emails": emails}

    @router.get("/email/sent")
    async def list_sent(user_id: str = verify_jwt):
        emails = await supabase.get_agent_emails(user_id, direction="outbound", status="sent")
        return {"emails": emails}

    return router
