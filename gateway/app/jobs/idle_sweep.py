"""Background job: suspend machines idle for >10 minutes."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.middleware.rate_limit import RateLimiter
from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.idle-sweep")

IDLE_THRESHOLD_MINUTES = 10
SWEEP_INTERVAL_SECONDS = 120
BATCH_SIZE = 10


async def _run_sweep(
    fly: FlyClient,
    supabase: SupabaseService,
    rate_limiter: RateLimiter | None,
    dev_machine_url: str = "",
) -> None:
    """Single sweep iteration."""
    threshold = (
        datetime.now(timezone.utc) - timedelta(minutes=IDLE_THRESHOLD_MINUTES)
    ).isoformat()

    machines = await supabase.claim_idle_machines(threshold, BATCH_SIZE)
    if machines:
        logger.info(f"[idle-sweep] Claimed {len(machines)} idle machines")

    for machine in machines:
        try:
            if not machine.fly_machine_id:
                # No Fly machine yet — reset to running
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
                continue

            # Health check — skip if machine reports active
            try:
                import httpx

                base = dev_machine_url if dev_machine_url else f"http://{machine.fly_machine_id}.vm.{machine.fly_app_name}.internal:18789"
                url = f"{base}/health"
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("active"):
                            logger.info(
                                f"[idle-sweep] Machine {machine.id} still active, skipping"
                            )
                            await supabase.update_user_machine(
                                machine.id, status=MachineStatus.running.value
                            )
                            await supabase.update_last_activity(machine.user_id)
                            continue
            except Exception:
                # Health check failed — proceed with suspension
                pass

            # Suspend the machine (skip Fly API call in dev mode)
            if dev_machine_url:
                logger.info(f"[idle-sweep] Dev mode — skipping suspend for {machine.id}")
            else:
                await fly.suspend_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.suspended.value
                )
                logger.info(f"[idle-sweep] Suspended machine {machine.id}")

        except Exception:
            logger.exception(f"[idle-sweep] Failed to suspend machine {machine.id}")
            # Reset to running — will be picked up next sweep
            try:
                await supabase.update_user_machine(
                    machine.id, status=MachineStatus.running.value
                )
            except Exception:
                pass

    # Cleanup stale rate limiter buckets
    if rate_limiter:
        rate_limiter.cleanup()


async def _sweep_loop(
    fly: FlyClient,
    supabase: SupabaseService,
    rate_limiter: RateLimiter | None,
    dev_machine_url: str = "",
) -> None:
    """Run sweeps forever with SWEEP_INTERVAL_SECONDS between each."""
    logger.info(
        f"[idle-sweep] Starting: {IDLE_THRESHOLD_MINUTES}min threshold, "
        f"{SWEEP_INTERVAL_SECONDS}s interval"
    )
    while True:
        try:
            await _run_sweep(fly, supabase, rate_limiter, dev_machine_url)
        except Exception:
            logger.exception("[idle-sweep] Sweep iteration failed")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def start_idle_sweep(
    fly: FlyClient,
    supabase: SupabaseService,
    rate_limiter: RateLimiter | None = None,
    dev_machine_url: str = "",
) -> asyncio.Task:
    """Launch the idle sweep as a background asyncio task."""
    return asyncio.create_task(
        _sweep_loop(fly, supabase, rate_limiter, dev_machine_url),
        name="idle-sweep",
    )
