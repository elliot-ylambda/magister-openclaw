"""User feedback endpoint: collects bug reports and sends them to Slack."""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException

from app.config import Settings
from app.models import FeedbackRequest
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.feedback")

VALID_CATEGORIES = {"bug", "wrong_answer", "slow", "other"}


def create_feedback_router(
    supabase: SupabaseService,
    settings: Settings,
    verify_jwt,
) -> APIRouter:
    router = APIRouter()

    @router.post("/feedback")
    async def submit_feedback(
        body: FeedbackRequest,
        user_id: str = verify_jwt,
    ):
        if body.category not in VALID_CATEGORIES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid category. Must be one of: {', '.join(sorted(VALID_CATEGORIES))}",
            )

        if not settings.slack_feedback_webhook_url:
            raise HTTPException(
                status_code=503,
                detail="Feedback service is not configured",
            )

        # Gather context
        machine = await supabase.get_user_machine(user_id)
        profile = await supabase.get_user_profile(user_id)

        email = profile.get("email", "unknown") if profile else "unknown"
        fly_app = machine.fly_app_name if machine else "unknown"
        ssh_cmd = f"fly ssh console -a {fly_app}" if machine else "N/A"
        model = machine.preferred_model if machine else "unknown"

        # Format message history (last 20)
        trimmed = body.messages[-20:]
        history_lines = []
        for msg in trimmed:
            prefix = "User" if msg.role == "user" else "Assistant"
            # Truncate long messages for Slack readability
            content = msg.content[:300] + "..." if len(msg.content) > 300 else msg.content
            history_lines.append(f"*{prefix}:* {content}")
        history_text = "\n".join(history_lines) if history_lines else "_No messages_"

        # Build Slack Block Kit message
        category_label = body.category.replace("_", " ").title()
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"🐛 Feedback: {category_label}"},
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*User:*\n{email}"},
                    {"type": "mrkdwn", "text": f"*Category:*\n{category_label}"},
                    {"type": "mrkdwn", "text": f"*Session:*\n`{body.session_id[:8]}...`"},
                    {"type": "mrkdwn", "text": f"*Model:*\n{model}"},
                ],
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*SSH:*\n`{ssh_cmd}`"},
            },
        ]

        if body.description:
            blocks.append({
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Description:*\n{body.description}"},
            })

        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Chat History (last {len(trimmed)}):*\n{history_text}"},
        })

        # Post to Slack
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                settings.slack_feedback_webhook_url,
                json={"blocks": blocks},
                timeout=10.0,
            )

        if resp.status_code != 200:
            logger.error(f"Slack webhook failed: {resp.status_code} {resp.text}")
            raise HTTPException(status_code=502, detail="Failed to send feedback")

        logger.info(f"[feedback] User {user_id} submitted {body.category} feedback")
        return {"status": "ok"}

    return router
