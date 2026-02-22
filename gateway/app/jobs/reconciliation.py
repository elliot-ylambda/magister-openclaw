"""Background job: clean up failed machine provisions."""

from __future__ import annotations

import asyncio
import logging

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.reconciliation")

RECONCILIATION_INTERVAL_SECONDS = 300  # 5 minutes
COOLDOWN_MINUTES = 5  # Don't clean up machines that just failed


async def _run_reconciliation(
    fly: FlyClient,
    supabase: SupabaseService,
) -> None:
    """Single reconciliation iteration.

    Finds machines with status='failed', tears down any partial Fly
    resources, and marks them as 'destroyed'.
    """
    machines = await supabase.get_failed_machines(COOLDOWN_MINUTES)
    if not machines:
        return

    logger.info(f"[reconciliation] Found {len(machines)} failed machines to clean up")

    for machine in machines:
        try:
            # Tear down in reverse provisioning order (same as destroy route)
            if machine.fly_machine_id:
                try:
                    await fly.stop_machine(machine.fly_app_name, machine.fly_machine_id)
                except Exception:
                    pass
                try:
                    await fly.delete_machine(
                        machine.fly_app_name, machine.fly_machine_id
                    )
                except Exception:
                    logger.warning(
                        f"[reconciliation] delete_machine failed for {machine.id}"
                    )

            if machine.fly_volume_id:
                try:
                    await fly.delete_volume(
                        machine.fly_app_name, machine.fly_volume_id
                    )
                except Exception:
                    logger.warning(
                        f"[reconciliation] delete_volume failed for {machine.id}"
                    )

            # Always attempt app deletion (created at step 1)
            if machine.provisioning_step >= 1:
                try:
                    await fly.delete_app(machine.fly_app_name)
                except Exception:
                    logger.warning(
                        f"[reconciliation] delete_app failed for {machine.id}"
                    )

            await supabase.update_user_machine(
                machine.id, status=MachineStatus.destroyed.value
            )
            logger.info(f"[reconciliation] Cleaned up machine {machine.id}")

        except Exception:
            logger.exception(
                f"[reconciliation] Failed to clean up machine {machine.id}"
            )


async def _reconciliation_loop(
    fly: FlyClient,
    supabase: SupabaseService,
) -> None:
    """Run reconciliation forever with interval between each."""
    logger.info(
        f"[reconciliation] Starting: {RECONCILIATION_INTERVAL_SECONDS}s interval, "
        f"{COOLDOWN_MINUTES}min cooldown"
    )
    while True:
        try:
            await _run_reconciliation(fly, supabase)
        except Exception:
            logger.exception("[reconciliation] Iteration failed")
        await asyncio.sleep(RECONCILIATION_INTERVAL_SECONDS)


def start_reconciliation(
    fly: FlyClient,
    supabase: SupabaseService,
) -> asyncio.Task:
    """Launch the reconciliation job as a background asyncio task."""
    return asyncio.create_task(
        _reconciliation_loop(fly, supabase),
        name="reconciliation",
    )
