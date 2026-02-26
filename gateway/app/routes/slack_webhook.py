"""POST /webhooks/slack — receive Slack events and forward to user's OpenClaw machine.

Flow:
1. Verify Slack HMAC-SHA256 signature
2. Handle url_verification challenge
3. Dedup by event_id
4. Ack 200 immediately
5. Background: route team_id → user → machine → wake if needed → forward
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from collections import OrderedDict

import httpx
from fastapi import APIRouter, BackgroundTasks, Request, Response

from app.config import Settings
from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.slack_webhook")

DEDUP_TTL = 300  # 5 minutes
DEDUP_MAX_SIZE = 10_000
WAKE_TIMEOUT_S = 45


def create_slack_webhook_router(
    fly: FlyClient,
    supabase: SupabaseService,
    settings: Settings,
) -> APIRouter:
    router = APIRouter()

    # Dedup cache: event_id → timestamp
    _seen_events: OrderedDict[str, float] = OrderedDict()
    _seen_lock = asyncio.Lock()

    # Per-team wake locks to prevent concurrent wake-up races
    _wake_locks: dict[str, asyncio.Lock] = {}

    def _verify_signature(body: bytes, timestamp: str, signature: str) -> bool:
        """Verify Slack HMAC-SHA256 request signature."""
        if not settings.slack_signing_secret:
            return False
        if abs(time.time() - float(timestamp)) > 300:
            return False
        sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
        computed = (
            "v0="
            + hmac.new(
                settings.slack_signing_secret.encode(),
                sig_basestring.encode(),
                hashlib.sha256,
            ).hexdigest()
        )
        return hmac.compare_digest(computed, signature)

    async def _dedup_check(event_id: str) -> bool:
        """Return True if this event_id was already seen (duplicate)."""
        now = time.time()
        async with _seen_lock:
            # Evict expired entries
            while _seen_events:
                oldest_id, oldest_ts = next(iter(_seen_events.items()))
                if now - oldest_ts > DEDUP_TTL:
                    _seen_events.pop(oldest_id)
                else:
                    break
            # Cap size
            while len(_seen_events) >= DEDUP_MAX_SIZE:
                _seen_events.popitem(last=False)
            if event_id in _seen_events:
                return True
            _seen_events[event_id] = now
            return False

    def _machine_url(machine, dev_override: str) -> str:
        if dev_override:
            return dev_override
        return f"http://{machine.fly_machine_id}.vm.{machine.fly_app_name}.internal:18789"

    async def _get_wake_lock(team_id: str) -> asyncio.Lock:
        if team_id not in _wake_locks:
            _wake_locks[team_id] = asyncio.Lock()
        return _wake_locks[team_id]

    async def _forward_to_machine(
        raw_body: bytes,
        slack_timestamp: str,
        slack_signature: str,
        team_id: str,
    ) -> None:
        """Route event to the correct user's OpenClaw machine."""
        try:
            # 1. Lookup slack_connection → user
            conn = await supabase.get_slack_connection_by_team(team_id)
            if not conn:
                logger.warning(f"[slack] no active connection for team {team_id}")
                return

            # 2. Lookup user → machine
            machine = await supabase.get_user_machine(conn.user_id)
            if not machine:
                logger.warning(f"[slack] no machine for user {conn.user_id}")
                return

            if machine.status in (
                MachineStatus.destroyed,
                MachineStatus.failed,
                MachineStatus.provisioning,
                MachineStatus.destroying,
            ):
                logger.warning(
                    f"[slack] machine {machine.id} in non-routable state: {machine.status}"
                )
                return

            # 3. Wake machine if suspended (with per-team lock)
            if machine.status == MachineStatus.suspended and not settings.dev_machine_url:
                lock = await _get_wake_lock(team_id)
                async with lock:
                    # Re-check status after acquiring lock (another event may have woken it)
                    machine = await supabase.get_user_machine(conn.user_id)
                    if machine and machine.status == MachineStatus.suspended:
                        try:
                            await fly.start_machine(
                                machine.fly_app_name, machine.fly_machine_id
                            )
                            await fly.wait_for_state(
                                machine.fly_app_name,
                                machine.fly_machine_id,
                                "started",
                                timeout_s=WAKE_TIMEOUT_S,
                            )
                            await supabase.update_user_machine(
                                machine.id, status=MachineStatus.running.value
                            )
                            logger.info(f"[slack] woke machine for team {team_id}")
                        except Exception:
                            logger.exception(
                                f"[slack] failed to wake machine for team {team_id}"
                            )
                            return

            # 4. Forward raw event to OpenClaw
            base_url = _machine_url(machine, settings.dev_machine_url)
            headers = {
                "content-type": "application/json",
                "x-slack-request-timestamp": slack_timestamp,
                "x-slack-signature": slack_signature,
            }
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{base_url}/slack/events",
                    content=raw_body,
                    headers=headers,
                )
                if resp.status_code >= 400:
                    logger.warning(
                        f"[slack] OpenClaw returned {resp.status_code} for team {team_id}: "
                        f"{resp.text[:200]}"
                    )

            # 5. Update activity
            await supabase.update_last_activity(conn.user_id)

        except Exception:
            logger.exception(f"[slack] error forwarding event for team {team_id}")

    @router.post("/webhooks/slack")
    async def slack_webhook(request: Request, background_tasks: BackgroundTasks):
        raw_body = await request.body()

        # Verify Slack signature
        timestamp = request.headers.get("x-slack-request-timestamp", "")
        signature = request.headers.get("x-slack-signature", "")
        if not _verify_signature(raw_body, timestamp, signature):
            return Response(status_code=401, content="Invalid signature")

        # Parse payload
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            return Response(status_code=400, content="Invalid JSON")

        # Handle Slack URL verification challenge
        if payload.get("type") == "url_verification":
            return {"challenge": payload.get("challenge", "")}

        # Dedup by event_id
        event_id = payload.get("event_id", "")
        if event_id and await _dedup_check(event_id):
            logger.debug(f"[slack] duplicate event {event_id}, skipping")
            return Response(status_code=200)

        # Ack immediately, process in background
        team_id = payload.get("team_id", "")
        if team_id:
            background_tasks.add_task(
                _forward_to_machine, raw_body, timestamp, signature, team_id
            )

        return Response(status_code=200)

    return router
