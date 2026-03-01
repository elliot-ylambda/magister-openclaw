"""Machine lifecycle control endpoints: stop, start, restart.

Dual auth: JWT (user-facing) or API key (admin/webapp).
"""

from __future__ import annotations

import hmac
import logging

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.machine_control")


class MachineControlRequest(BaseModel):
    user_id: str | None = None


def create_machine_control_router(
    fly: FlyClient,
    supabase: SupabaseService,
    *,
    jwt_secret: str,
    api_key: str,
    supabase_url: str = "",
) -> APIRouter:
    router = APIRouter()

    # Set up JWKS client for ES256 verification
    jwks_client = None
    if supabase_url:
        from jwt import PyJWKClient

        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)

    async def resolve_user(request: Request, body_user_id: str | None) -> str:
        """Resolve user_id from JWT or API key auth."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = auth[7:]

        # Check if it's an API key (admin path)
        if hmac.compare_digest(token, api_key):
            if not body_user_id:
                raise HTTPException(
                    status_code=400, detail="user_id required for admin calls"
                )
            return body_user_id

        # Otherwise decode as JWT (user path)
        try:
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg", "HS256")

            if alg == "ES256" and jwks_client:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = pyjwt.decode(
                    token,
                    signing_key.key,
                    algorithms=["ES256"],
                    audience="authenticated",
                )
            else:
                payload = pyjwt.decode(
                    token,
                    jwt_secret,
                    algorithms=["HS256"],
                    audience="authenticated",
                )
        except pyjwt.exceptions.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="JWT missing sub claim")
        return user_id

    @router.post("/machine/stop")
    async def stop_machine(request: Request, body: MachineControlRequest = MachineControlRequest()):
        user_id = await resolve_user(request, body.user_id)
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if machine.status == MachineStatus.stopped:
            return {"status": "already_stopped"}

        if machine.status not in (MachineStatus.running, MachineStatus.suspended):
            raise HTTPException(
                status_code=409,
                detail=f"Cannot stop machine in '{machine.status.value}' state",
            )

        # Set transient status
        await supabase.update_user_machine(
            machine.id, status=MachineStatus.stopping.value
        )

        try:
            # Only call Fly if machine is running (suspended is already paused)
            if machine.status == MachineStatus.running and machine.fly_machine_id:
                await fly.suspend_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )

            await supabase.update_user_machine(
                machine.id, status=MachineStatus.stopped.value
            )
            logger.info(f"[machine_control] Stopped machine for user {user_id}")
            return {"status": "stopped"}
        except Exception:
            logger.exception(f"[machine_control] Stop failed for user {user_id}")
            # Roll back to previous status
            await supabase.update_user_machine(
                machine.id, status=machine.status.value
            )
            raise HTTPException(status_code=502, detail="Failed to stop machine")

    @router.post("/machine/start")
    async def start_machine(request: Request, body: MachineControlRequest = MachineControlRequest()):
        user_id = await resolve_user(request, body.user_id)
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if machine.status == MachineStatus.running:
            return {"status": "already_running"}

        if machine.status not in (MachineStatus.stopped, MachineStatus.suspended):
            raise HTTPException(
                status_code=409,
                detail=f"Cannot start machine in '{machine.status.value}' state",
            )

        if not machine.fly_machine_id:
            raise HTTPException(status_code=409, detail="Machine has no Fly instance")

        try:
            await fly.start_machine(machine.fly_app_name, machine.fly_machine_id)
            await fly.wait_for_state(
                machine.fly_app_name, machine.fly_machine_id, "started", timeout_s=30
            )
            await supabase.update_user_machine(
                machine.id, status=MachineStatus.running.value
            )
            logger.info(f"[machine_control] Started machine for user {user_id}")
            return {"status": "running"}
        except Exception:
            logger.exception(f"[machine_control] Start failed for user {user_id}")
            raise HTTPException(status_code=502, detail="Failed to start machine")

    @router.post("/machine/restart")
    async def restart_machine(request: Request, body: MachineControlRequest = MachineControlRequest()):
        user_id = await resolve_user(request, body.user_id)
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        if not machine.fly_machine_id:
            raise HTTPException(status_code=409, detail="Machine has no Fly instance")

        try:
            if machine.status == MachineStatus.running:
                # Stop then start
                await fly.stop_machine(machine.fly_app_name, machine.fly_machine_id)
                await fly.wait_for_state(
                    machine.fly_app_name, machine.fly_machine_id, "stopped", timeout_s=30
                )

            # Start (works for stopped, suspended, or just-stopped)
            await fly.start_machine(machine.fly_app_name, machine.fly_machine_id)
            await fly.wait_for_state(
                machine.fly_app_name, machine.fly_machine_id, "started", timeout_s=30
            )
            await supabase.update_user_machine(
                machine.id, status=MachineStatus.running.value
            )
            logger.info(f"[machine_control] Restarted machine for user {user_id}")
            return {"status": "restarted"}
        except Exception:
            logger.exception(f"[machine_control] Restart failed for user {user_id}")
            raise HTTPException(status_code=502, detail="Failed to restart machine")

    return router
