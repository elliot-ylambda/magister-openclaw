"""POST /api/admin/secrets/push — push merged global+override secrets to user machines.

Called by the admin dashboard. Uses verify_api_key auth (same as provision/destroy).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.admin_secrets")


class PushSecretsRequest(BaseModel):
    user_id: str | None = None


def create_admin_secrets_router(
    fly: FlyClient,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    @router.post("/admin/secrets/push")
    async def push_secrets(req: PushSecretsRequest):
        """Push merged global+user-override secrets to Fly machines.

        If user_id is provided, push to that single machine (start if suspended).
        If user_id is omitted, push to all active machines (don't start suspended).
        """
        if req.user_id:
            return await _push_to_user(req.user_id)
        return await _push_to_all()

    async def _push_to_user(user_id: str) -> dict:
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if machine.status in (MachineStatus.destroyed, MachineStatus.destroying):
            raise HTTPException(status_code=410, detail="Machine destroyed")

        secrets = await supabase.get_merged_secrets_for_user(user_id)
        if not secrets:
            return {"status": "no_secrets", "user_id": user_id}

        # Start machine BEFORE setting secrets — the GraphQL setSecrets
        # mutation triggers a Fly deployment that fails with "no machines
        # available" if the machine is suspended/stopped.
        if machine.fly_machine_id and machine.status in (
            MachineStatus.suspended, MachineStatus.stopped,
        ):
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
                    f"[admin_secrets] failed to start machine before secret push for {user_id}"
                )

        await fly.set_secrets(machine.fly_app_name, secrets)
        logger.info(f"[admin_secrets] pushed {len(secrets)} secrets to user {user_id}")

        return {"status": "pushed", "user_id": user_id, "count": len(secrets)}

    async def _push_to_all() -> dict:
        machines = await supabase.get_active_machines()
        results: list[dict] = []
        errors: list[dict] = []

        for machine in machines:
            try:
                secrets = await supabase.get_merged_secrets_for_user(machine.user_id)
                if not secrets:
                    results.append({"user_id": machine.user_id, "status": "no_secrets"})
                    continue

                await fly.set_secrets(machine.fly_app_name, secrets)
                results.append({
                    "user_id": machine.user_id,
                    "status": "pushed",
                    "count": len(secrets),
                })
                logger.info(
                    f"[admin_secrets] pushed {len(secrets)} secrets to {machine.fly_app_name}"
                )
            except Exception as exc:
                logger.exception(
                    f"[admin_secrets] failed to push secrets to {machine.fly_app_name}"
                )
                errors.append({
                    "user_id": machine.user_id,
                    "error": str(exc),
                })

        return {
            "status": "bulk_push_complete",
            "pushed": len(results),
            "errors": len(errors),
            "details": results,
            "error_details": errors,
        }

    return router
