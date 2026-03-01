"""Tests for the reconciliation background job."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.jobs.reconciliation import _cleanup_failed_machines, _reconcile_running_machines
from app.models import MachineStatus, UserMachine


def _make_machine(**overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id="user-1",
        fly_app_name="magister-user1",
        fly_machine_id=None,
        fly_volume_id=None,
        fly_region="iad",
        status=MachineStatus.failed,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        current_image=None,
        provisioning_step=1,
        updated_at=(datetime.now(timezone.utc) - timedelta(minutes=10)),
        created_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_failed_machines.return_value = []
    mock.get_running_machines.return_value = []
    mock.update_user_machine.return_value = None
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.stop_machine.return_value = None
    mock.start_machine.return_value = None
    mock.delete_machine.return_value = None
    mock.delete_volume.return_value = None
    mock.delete_app.return_value = None
    mock.get_machine.return_value = {"state": "started"}
    return mock


# ── Failed machine cleanup tests ─────────────────────────────────


async def test_cleanup_no_failed_machines(mock_fly, mock_supabase):
    """Does nothing when no failed machines exist."""
    await _cleanup_failed_machines(mock_fly, mock_supabase)
    mock_fly.delete_app.assert_not_called()


async def test_cleanup_partial_app(mock_fly, mock_supabase):
    """Cleans up a failed machine that only has a Fly app (step 1)."""
    mock_supabase.get_failed_machines.return_value = [
        _make_machine(provisioning_step=1)
    ]
    await _cleanup_failed_machines(mock_fly, mock_supabase)
    mock_fly.delete_app.assert_called_once_with("magister-user1")
    mock_supabase.update_user_machine.assert_called()


async def test_cleanup_full_resources(mock_fly, mock_supabase):
    """Cleans up a failed machine with app, volume, and machine."""
    mock_supabase.get_failed_machines.return_value = [
        _make_machine(
            provisioning_step=4,
            fly_machine_id="mach_123",
            fly_volume_id="vol_123",
        )
    ]
    await _cleanup_failed_machines(mock_fly, mock_supabase)
    mock_fly.stop_machine.assert_called_once()
    mock_fly.delete_machine.assert_called_once()
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()


async def test_cleanup_continues_on_failure(mock_fly, mock_supabase):
    """Continues cleanup even if individual steps fail."""
    mock_supabase.get_failed_machines.return_value = [
        _make_machine(
            provisioning_step=4,
            fly_machine_id="mach_123",
            fly_volume_id="vol_123",
        )
    ]
    mock_fly.delete_machine.side_effect = Exception("API error")
    await _cleanup_failed_machines(mock_fly, mock_supabase)
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()


# ── Running machine state sync tests ─────────────────────────────


async def test_reconcile_no_running_machines(mock_fly, mock_supabase):
    """Does nothing when no running machines exist."""
    await _reconcile_running_machines(mock_fly, mock_supabase)
    mock_fly.get_machine.assert_not_called()
    mock_supabase.update_user_machine.assert_not_called()


async def test_reconcile_running_machine_actually_running(mock_fly, mock_supabase):
    """Does not update DB when Fly confirms machine is started."""
    mock_supabase.get_running_machines.return_value = [
        _make_machine(
            status=MachineStatus.running,
            fly_machine_id="mach_123",
        )
    ]
    mock_fly.get_machine.return_value = {"state": "started"}

    await _reconcile_running_machines(mock_fly, mock_supabase)

    mock_fly.get_machine.assert_called_once_with("magister-user1", "mach_123")
    mock_supabase.update_user_machine.assert_not_called()


async def test_reconcile_running_but_fly_suspended(mock_fly, mock_supabase):
    """Restarts machine when Fly reports it as suspended."""
    mock_supabase.get_running_machines.return_value = [
        _make_machine(
            status=MachineStatus.running,
            fly_machine_id="mach_123",
        )
    ]
    mock_fly.get_machine.return_value = {"state": "suspended"}

    await _reconcile_running_machines(mock_fly, mock_supabase)

    mock_fly.start_machine.assert_called_once_with("magister-user1", "mach_123")
    mock_supabase.update_user_machine.assert_not_called()


async def test_reconcile_running_but_fly_stopped(mock_fly, mock_supabase):
    """Restarts machine when Fly reports it as stopped."""
    mock_supabase.get_running_machines.return_value = [
        _make_machine(
            status=MachineStatus.running,
            fly_machine_id="mach_123",
        )
    ]
    mock_fly.get_machine.return_value = {"state": "stopped"}

    await _reconcile_running_machines(mock_fly, mock_supabase)

    mock_fly.start_machine.assert_called_once_with("magister-user1", "mach_123")
    mock_supabase.update_user_machine.assert_not_called()


async def test_reconcile_continues_on_fly_api_error(mock_fly, mock_supabase):
    """Continues checking other machines when Fly API fails for one."""
    machines = [
        _make_machine(id="m1", fly_machine_id="mach_1", status=MachineStatus.running),
        _make_machine(id="m2", fly_machine_id="mach_2", fly_app_name="magister-user2", status=MachineStatus.running),
    ]
    mock_supabase.get_running_machines.return_value = machines

    # First call fails, second returns suspended
    mock_fly.get_machine.side_effect = [
        Exception("API error"),
        {"state": "suspended"},
    ]

    await _reconcile_running_machines(mock_fly, mock_supabase)

    # Should still restart the second machine
    mock_fly.start_machine.assert_called_once_with("magister-user2", "mach_2")
