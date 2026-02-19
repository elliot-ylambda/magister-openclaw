"""POST /api/provision — idempotent multi-step machine provisioning."""

from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, HTTPException

from app.config import Settings
from app.middleware.auth import hash_token
from app.models import MachineStatus, ProvisionRequest
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.provision")


def create_provision_router(
    fly: FlyClient,
    supabase: SupabaseService,
    settings: Settings,
) -> APIRouter:
    router = APIRouter()

    @router.post("/provision")
    async def provision(req: ProvisionRequest):
        user_id = req.user_id
        plan = req.plan
        region = req.region or settings.default_region

        # Check for existing machine (idempotent)
        machine = await supabase.get_user_machine(user_id)

        if machine and machine.status == MachineStatus.running:
            return {"status": "already_running", "machine_id": machine.id}

        if machine and machine.status == MachineStatus.provisioning:
            # Resume from last completed step
            pass
        else:
            # Step 0: Create DB record
            fly_app_name = f"magister-{user_id[:8]}"
            machine = await supabase.create_user_machine(
                {
                    "user_id": user_id,
                    "fly_app_name": fly_app_name,
                    "fly_region": region,
                    "plan": plan,
                    "status": MachineStatus.provisioning.value,
                    "provisioning_step": 0,
                }
            )

        try:
            # Step 1: Create Fly App
            if machine.provisioning_step < 1:
                await fly.create_app(machine.fly_app_name)
                await supabase.update_user_machine(
                    machine.id, provisioning_step=1
                )
                machine.provisioning_step = 1
                logger.info(f"[provision] step 1 done: app created for {user_id}")

            # Step 2: Generate token + set Fly secrets (combined for atomicity)
            if machine.provisioning_step < 2:
                token = machine.gateway_token or secrets.token_urlsafe(32)
                token_hash = hash_token(token)
                await fly.set_secrets(
                    machine.fly_app_name,
                    {"GATEWAY_TOKEN": token},
                )
                await supabase.update_user_machine(
                    machine.id,
                    gateway_token=token,
                    gateway_token_hash=token_hash,
                    provisioning_step=2,
                )
                machine.provisioning_step = 2
                machine.gateway_token = token
                logger.info(f"[provision] step 2 done: secrets set for {user_id}")

            # Step 3: Create Volume (5GB)
            if machine.provisioning_step < 3:
                vol = await fly.create_volume(
                    machine.fly_app_name, "data", 5, region
                )
                await supabase.update_user_machine(
                    machine.id,
                    fly_volume_id=vol["id"],
                    provisioning_step=3,
                )
                machine.provisioning_step = 3
                machine.fly_volume_id = vol["id"]
                logger.info(f"[provision] step 3 done: volume created for {user_id}")

            # Step 4: Create Machine
            if machine.provisioning_step < 4:
                machine_config = {
                    "region": region,
                    "config": {
                        "image": settings.openclaw_image,
                        "guest": {"cpu_kind": "shared", "cpus": 2, "memory_mb": 2048},
                        "mounts": [
                            {
                                "volume": machine.fly_volume_id,
                                "path": "/data",
                            }
                        ],
                    },
                }
                result = await fly.create_machine(
                    machine.fly_app_name, machine_config
                )
                await supabase.update_user_machine(
                    machine.id,
                    fly_machine_id=result["id"],
                    current_image=settings.openclaw_image,
                    provisioning_step=4,
                )
                machine.provisioning_step = 4
                machine.fly_machine_id = result["id"]
                logger.info(f"[provision] step 4 done: machine created for {user_id}")

            # Step 5: Wait for started state
            if machine.provisioning_step < 5:
                await fly.wait_for_state(
                    machine.fly_app_name,
                    machine.fly_machine_id,
                    "started",
                    timeout_s=60,
                )
                await supabase.update_user_machine(
                    machine.id,
                    status=MachineStatus.running.value,
                    provisioning_step=5,
                )
                logger.info(f"[provision] step 5 done: machine running for {user_id}")

            return {"status": "provisioned", "machine_id": machine.id}

        except Exception:
            logger.exception(f"[provision] failed for {user_id}")
            await supabase.update_user_machine(
                machine.id, status=MachineStatus.failed.value
            )
            raise HTTPException(status_code=500, detail="Provisioning failed")

    return router
