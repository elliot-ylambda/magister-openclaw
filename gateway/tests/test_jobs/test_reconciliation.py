"""Tests for the reconciliation background job."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.jobs.reconciliation import _run_reconciliation
from app.models import MachineStatus, UserMachine


def _make_failed_machine(**overrides) -> UserMachine:
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
        # Failed 10 minutes ago (past the 5-min cooldown)
        updated_at=(datetime.now(timezone.utc) - timedelta(minutes=10)),
        created_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_failed_machines.return_value = []
    mock.update_user_machine.return_value = None
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.stop_machine.return_value = None
    mock.delete_machine.return_value = None
    mock.delete_volume.return_value = None
    mock.delete_app.return_value = None
    return mock


async def test_reconciliation_no_failed_machines(mock_fly, mock_supabase):
    """Does nothing when no failed machines exist."""
    await _run_reconciliation(mock_fly, mock_supabase)
    mock_fly.delete_app.assert_not_called()


async def test_reconciliation_cleans_up_partial_app(mock_fly, mock_supabase):
    """Cleans up a failed machine that only has a Fly app (step 1)."""
    mock_supabase.get_failed_machines.return_value = [
        _make_failed_machine(provisioning_step=1)
    ]
    await _run_reconciliation(mock_fly, mock_supabase)
    mock_fly.delete_app.assert_called_once_with("magister-user1")
    mock_supabase.update_user_machine.assert_called()


async def test_reconciliation_cleans_up_full_resources(mock_fly, mock_supabase):
    """Cleans up a failed machine with app, volume, and machine."""
    mock_supabase.get_failed_machines.return_value = [
        _make_failed_machine(
            provisioning_step=4,
            fly_machine_id="mach_123",
            fly_volume_id="vol_123",
        )
    ]
    await _run_reconciliation(mock_fly, mock_supabase)
    mock_fly.stop_machine.assert_called_once()
    mock_fly.delete_machine.assert_called_once()
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()


async def test_reconciliation_continues_on_cleanup_failure(mock_fly, mock_supabase):
    """Continues cleanup even if individual steps fail."""
    mock_supabase.get_failed_machines.return_value = [
        _make_failed_machine(
            provisioning_step=4,
            fly_machine_id="mach_123",
            fly_volume_id="vol_123",
        )
    ]
    mock_fly.delete_machine.side_effect = Exception("API error")
    await _run_reconciliation(mock_fly, mock_supabase)
    # Should still attempt volume and app deletion
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()
