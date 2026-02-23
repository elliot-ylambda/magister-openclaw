"""POST /api/chat — SSE proxy to the user's OpenClaw machine."""

from __future__ import annotations

import logging
import time
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.middleware.rate_limit import RateLimiter
from app.models import ChatRequest, MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.chat")

# Per-instance concurrency lock: one streaming request per user
_active_requests: set[str] = set()

ACTIVITY_DEBOUNCE_SECONDS = 30.0


def _machine_url(machine, dev_override: str) -> str:
    """Return the base URL for a user's OpenClaw machine.

    When *dev_override* is set (local dev), use it directly.
    Otherwise build the Fly-internal DNS address.
    """
    if dev_override:
        return dev_override
    return f"http://{machine.fly_machine_id}.vm.{machine.fly_app_name}.internal:18789"


def create_chat_router(
    fly: FlyClient,
    supabase: SupabaseService,
    rate_limiter: RateLimiter,
    verify_jwt,
    dev_machine_url: str = "",
) -> APIRouter:
    router = APIRouter()

    @router.post("/chat")
    async def chat(req: ChatRequest, user_id: str = verify_jwt):
        # Rate limit
        rate_limiter.check(user_id)

        # Lookup machine
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        # Status-based routing
        if machine.status == MachineStatus.destroyed:
            raise HTTPException(status_code=410, detail="Machine destroyed")
        if machine.status == MachineStatus.failed:
            raise HTTPException(status_code=500, detail="Machine in failed state")
        if machine.status == MachineStatus.provisioning:
            raise HTTPException(
                status_code=503, detail="Machine is still provisioning"
            )

        # Concurrency lock
        if user_id in _active_requests:
            raise HTTPException(
                status_code=409, detail="Another chat request is already active"
            )

        # Wake suspended machine (skip in dev — no Fly API locally)
        if machine.status == MachineStatus.suspended and not dev_machine_url:
            try:
                await fly.start_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )
                await fly.wait_for_state(
                    machine.fly_app_name,
                    machine.fly_machine_id,
                    "started",
                    timeout_s=30,
                )
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
            except Exception:
                logger.exception(f"[chat] wake-up failed for {user_id}")
                raise HTTPException(
                    status_code=503, detail="Failed to wake machine"
                )

        # Health check before proxying
        machine_url = _machine_url(machine, dev_machine_url)
        try:
            async with httpx.AsyncClient(timeout=5.0) as hc:
                resp = await hc.get(f"{machine_url}/health")
                resp.raise_for_status()
        except Exception:
            logger.warning(f"[chat] health check failed for {user_id}")
            raise HTTPException(
                status_code=503, detail="Machine not ready"
            )

        if req.stream:
            return EventSourceResponse(
                _stream_chat(machine_url, machine, req, user_id, supabase)
            )

        # Non-streaming: collect all chunks via the same generator
        content_parts: list[str] = []
        error_message: str | None = None
        async for event in _stream_chat(machine_url, machine, req, user_id, supabase):
            if event["event"] == "chunk":
                content_parts.append(event["data"])
            elif event["event"] == "error":
                error_message = event["data"]

        if error_message:
            status = 502 if "Upstream" in (error_message or "") else 500
            raise HTTPException(status_code=status, detail=error_message)

        return {"content": "".join(content_parts), "session_id": req.session_id}

    async def _stream_chat(
        machine_url: str,
        machine,
        req: ChatRequest,
        user_id: str,
        supabase: SupabaseService,
    ) -> AsyncIterator[dict]:
        _active_requests.add(user_id)
        last_activity_update = 0.0
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST",
                    f"{machine_url}/api/chat",
                    json={"message": req.message, "session_id": req.session_id},
                    headers={"Authorization": f"Bearer {machine.gateway_token}"},
                ) as resp:
                    if resp.status_code != 200:
                        yield {"event": "error", "data": f"Upstream {resp.status_code}"}
                        return
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        yield {"event": "chunk", "data": line}

                        # Debounced activity tracking
                        now = time.monotonic()
                        if now - last_activity_update > ACTIVITY_DEBOUNCE_SECONDS:
                            last_activity_update = now
                            try:
                                await supabase.update_last_activity(user_id)
                            except Exception:
                                pass

            yield {"event": "done", "data": ""}
        except Exception as exc:
            logger.exception(f"[chat] stream error for {user_id}")
            yield {"event": "error", "data": str(exc)}
        finally:
            _active_requests.discard(user_id)
            # Always update activity on stream end
            try:
                await supabase.update_last_activity(user_id)
            except Exception:
                pass

    return router
