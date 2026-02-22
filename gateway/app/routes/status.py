"""GET /api/status — return machine status for the authenticated user."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.status")


def create_status_router(
    fly: FlyClient,
    supabase: SupabaseService,
    verify_jwt,
) -> APIRouter:
    router = APIRouter()

    @router.get("/status")
    async def status(user_id: str = verify_jwt):
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        # Live query Fly state if machine has a fly_machine_id
        fly_state = None
        if machine.fly_machine_id:
            try:
                info = await fly.get_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )
                fly_state = info.get("state")
            except Exception:
                logger.warning(f"[status] fly query failed for {user_id}")

        return {
            "status": machine.status.value,
            "fly_state": fly_state,
            "region": machine.fly_region,
            "last_activity": (
                machine.last_activity.isoformat() if machine.last_activity else None
            ),
            "plan": machine.plan,
            "llm_spend_cents": await supabase.get_monthly_llm_spend(user_id),
        }

    return router
