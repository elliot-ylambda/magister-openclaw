"""Slack OAuth helper routes — inject/remove Fly secrets for Slack integration.

Called by the webapp after OAuth completes (inject) or on disconnect (remove).
Both routes use verify_api_key auth (same as provision/destroy).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.slack_oauth")

SLACK_SECRET_KEYS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]


class InjectSecretsRequest(BaseModel):
    user_id: str
    bot_token: str
    signing_secret: str


class RemoveSecretsRequest(BaseModel):
    user_id: str


def create_slack_oauth_router(
    fly: FlyClient,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    @router.post("/slack/inject-secrets")
    async def inject_secrets(req: InjectSecretsRequest):
        """Set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET as Fly secrets on user's machine."""
        machine = await supabase.get_user_machine(req.user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if machine.status in (MachineStatus.destroyed, MachineStatus.destroying):
            raise HTTPException(status_code=410, detail="Machine destroyed")

        await fly.set_secrets(
            machine.fly_app_name,
            {
                "SLACK_BOT_TOKEN": req.bot_token,
                "SLACK_SIGNING_SECRET": req.signing_secret,
            },
        )
        logger.info(f"[slack] injected Slack secrets for user {req.user_id}")

        # Start machine if suspended so it picks up new secrets
        if machine.status == MachineStatus.suspended:
            try:
                await fly.start_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )
                await fly.wait_for_state(
                    machine.fly_app_name,
                    machine.fly_machine_id,
                    "started",
                    timeout_s=60,
                )
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
            except Exception:
                logger.exception(
                    f"[slack] failed to start machine after secret injection for {req.user_id}"
                )

        return {"status": "secrets_injected"}

    @router.post("/slack/remove-secrets")
    async def remove_secrets(req: RemoveSecretsRequest):
        """Unset Slack secrets from user's Fly machine."""
        machine = await supabase.get_user_machine(req.user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if machine.status in (MachineStatus.destroyed, MachineStatus.destroying):
            return {"status": "already_destroyed"}

        try:
            await fly.unset_secrets(machine.fly_app_name, SLACK_SECRET_KEYS)
            logger.info(f"[slack] removed Slack secrets for user {req.user_id}")
        except Exception:
            logger.exception(
                f"[slack] failed to remove secrets for {req.user_id}"
            )

        return {"status": "secrets_removed"}

    return router
