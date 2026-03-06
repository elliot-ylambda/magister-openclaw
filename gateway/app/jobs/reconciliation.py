"""Background job: clean up failed provisions + sync running machine state."""

from __future__ import annotations

import asyncio
import logging

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.reconciliation")

RECONCILIATION_INTERVAL_SECONDS = 300  # 5 minutes
COOLDOWN_MINUTES = 5  # Don't clean up machines that just failed

# Fly.io states that indicate a machine is not running
FLY_STOPPED_STATES = {"suspended", "stopped"}


async def _reconcile_running_machines(
    fly: FlyClient,
    supabase: SupabaseService,
) -> None:
    """Check machines marked 'running' in DB against actual Fly.io state.

    If Fly.io has stopped or suspended a machine unexpectedly, restart it
    so user machines stay running at all times.
    """
    machines = await supabase.get_running_machines()
    if not machines:
        return

    for machine in machines:
        try:
            info = await fly.get_machine(
                machine.fly_app_name, machine.fly_machine_id
            )
            fly_state = info.get("state")
            if fly_state in FLY_STOPPED_STATES:
                # Machine was stopped/suspended unexpectedly — restart it
                logger.info(
                    f"[reconciliation] Machine {machine.id} is '{fly_state}' "
                    f"on Fly but should be running — restarting"
                )
                await fly.start_machine(
                    machine.fly_app_name, machine.fly_machine_id
                )
                logger.info(
                    f"[reconciliation] Restarted machine {machine.id}"
                )
        except Exception:
            logger.warning(
                f"[reconciliation] Failed to check/restart machine {machine.id}"
            )


async def _cleanup_failed_machines(
    fly: FlyClient,
    supabase: SupabaseService,
) -> None:
    """Find machines with status='failed', tear down partial Fly resources,
    and mark them as 'destroyed'."""
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
            await _reconcile_running_machines(fly, supabase)
        except Exception:
            logger.exception("[reconciliation] State sync failed")
        try:
            await _cleanup_failed_machines(fly, supabase)
        except Exception:
            logger.exception("[reconciliation] Failed cleanup failed")
        try:
            deleted = await supabase.cleanup_expired_browser_tokens()
            if deleted:
                logger.info(f"[reconciliation] Cleaned up {deleted} expired browser tokens")
        except Exception:
            logger.exception("[reconciliation] Browser token cleanup failed")
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
