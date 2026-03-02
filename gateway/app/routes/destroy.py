"""POST /api/destroy — tear down a user's Fly machine and resources."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.destroy")


class DestroyRequest(BaseModel):
    user_id: str


def create_destroy_router(
    fly: FlyClient,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    @router.post("/destroy")
    async def destroy(req: DestroyRequest):
        machine = await supabase.get_user_machine(req.user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        await supabase.update_user_machine(
            machine.id, status=MachineStatus.destroying.value
        )

        # Defensively tear down each resource — continue on failure
        if machine.fly_machine_id:
            try:
                await fly.stop_machine(machine.fly_app_name, machine.fly_machine_id)
            except Exception:
                logger.warning(f"[destroy] stop_machine failed for {req.user_id}")
            try:
                await fly.delete_machine(machine.fly_app_name, machine.fly_machine_id)
            except Exception:
                logger.warning(f"[destroy] delete_machine failed for {req.user_id}")

        if machine.fly_volume_id:
            try:
                await fly.delete_volume(machine.fly_app_name, machine.fly_volume_id)
            except Exception:
                logger.warning(f"[destroy] delete_volume failed for {req.user_id}")

        try:
            await fly.delete_app(machine.fly_app_name)
        except Exception:
            logger.warning(f"[destroy] delete_app failed for {req.user_id}")

        await supabase.update_user_machine(
            machine.id, status=MachineStatus.destroyed.value
        )
        logger.info(f"[destroy] complete for {req.user_id}")

        return {"status": "destroyed", "machine_id": machine.id}

    return router
