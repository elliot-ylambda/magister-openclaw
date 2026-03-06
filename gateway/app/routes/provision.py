"""POST /api/provision — idempotent multi-step machine provisioning."""

from __future__ import annotations

import asyncio
import logging
import secrets

import httpx
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

        # Check for existing machine — unfiltered so we see destroyed records too
        machine = await supabase.get_user_machine_for_provision(user_id)

        if machine:
            match machine.status:
                case MachineStatus.running | MachineStatus.suspended:
                    return {
                        "status": "already_provisioned",
                        "machine_id": machine.id,
                    }

                case MachineStatus.provisioning:
                    pass  # resume from last completed step

                case MachineStatus.failed:
                    # Reset to provisioning — resume from last completed step.
                    # Fly resources from completed steps still exist because
                    # reconciliation hasn't run yet (status would be destroyed).
                    await supabase.update_user_machine(
                        machine.id, status=MachineStatus.provisioning.value
                    )

                case MachineStatus.destroying:
                    raise HTTPException(
                        409, "Machine is being destroyed, retry later"
                    )

                case MachineStatus.destroyed:
                    # Clear the ghost record so fly_app_name is free for reuse
                    await supabase.delete_user_machine(machine.id)
                    machine = None  # fall through to create new

        if machine is None:
            # Step 0: Create fresh DB record
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

        # Assign agent email address (after DB record exists, before secrets)
        if not getattr(machine, "email_address", None):
            email_prefix = f"agent-{user_id[:8]}"
            email_address = f"{email_prefix}@{settings.agent_email_domain}"
            try:
                await supabase.update_user_machine(
                    machine.id,
                    email_address=email_address,
                )
            except Exception:
                # Fallback to full user_id if short prefix collides
                email_address = f"agent-{user_id}@{settings.agent_email_domain}"
                await supabase.update_user_machine(
                    machine.id,
                    email_address=email_address,
                )
            machine.email_address = email_address
            logger.info(
                f"[provision] email assigned: {email_address} for {user_id}"
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
                # Start with admin-managed global secrets (filtered for reserved prefixes)
                global_secrets = await supabase.get_merged_secrets_for_user(user_id)
                fly_secrets: dict[str, str] = {**global_secrets}

                # System secrets set AFTER globals so they can't be overwritten
                token = machine.gateway_token or secrets.token_urlsafe(32)
                token_hash = hash_token(token)
                fly_secrets["GATEWAY_TOKEN"] = token

                # Include Slack tokens if user already connected Slack
                slack_conn = await supabase.get_slack_connection(user_id)
                if slack_conn and slack_conn.bot_token:
                    fly_secrets["SLACK_BOT_TOKEN"] = slack_conn.bot_token
                    fly_secrets["SLACK_SIGNING_SECRET"] = settings.slack_signing_secret
                    logger.info(f"[provision] including Slack secrets for {user_id}")

                # Set default model from admin config
                default_model = await supabase.get_app_setting("default_model")
                default_model = default_model or "anthropic/claude-opus-4-6"
                fly_secrets["DEFAULT_MODEL"] = default_model

                # Agent email address so the machine knows its own address
                fly_secrets["AGENT_EMAIL_ADDRESS"] = machine.email_address

                await fly.set_secrets(machine.fly_app_name, fly_secrets)
                await supabase.update_user_machine(
                    machine.id,
                    gateway_token=token,
                    gateway_token_hash=token_hash,
                    preferred_model=default_model,
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
                        "auto_destroy": False,
                        "restart": {"policy": "always"},
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

            # Step 5: Wait for Fly container to start
            if machine.provisioning_step < 5:
                await fly.wait_for_state(
                    machine.fly_app_name,
                    machine.fly_machine_id,
                    "started",
                    timeout_s=180,
                )
                await supabase.update_user_machine(
                    machine.id, provisioning_step=5
                )
                machine.provisioning_step = 5
                logger.info(f"[provision] step 5 done: container started for {user_id}")

            # Step 6: Poll health until OpenClaw is fully ready
            # (UI build + agent init takes ~60s after container starts)
            if machine.status not in (MachineStatus.running, MachineStatus.suspended):
                health_url = (
                    f"http://{machine.fly_machine_id}.vm."
                    f"{machine.fly_app_name}.internal:18790/health"
                )
                for _ in range(24):  # up to ~120s
                    try:
                        async with httpx.AsyncClient(timeout=5.0) as hc:
                            resp = await hc.get(health_url)
                            resp.raise_for_status()
                        break
                    except Exception:
                        await asyncio.sleep(5)
                else:
                    raise TimeoutError("OpenClaw health check never passed")

                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
                logger.info(f"[provision] app healthy, machine running for {user_id}")

            return {"status": "provisioned", "machine_id": machine.id}

        except Exception:
            logger.exception(f"[provision] failed for {user_id}")
            await supabase.update_user_machine(
                machine.id, status=MachineStatus.failed.value
            )
            raise HTTPException(status_code=500, detail="Provisioning failed")

    return router
