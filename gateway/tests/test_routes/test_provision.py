"""Tests for the /api/provision route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import MachineStatus, UserMachine
from app.routes.provision import create_provision_router


def _make_machine(status: MachineStatus = MachineStatus.running, **overrides) -> UserMachine:
    defaults = dict(
        id="machine-1",
        user_id="user-1",
        fly_app_name="magister-user1",
        fly_machine_id="mach_123",
        fly_volume_id="vol_123",
        fly_region="iad",
        status=status,
        last_activity=datetime.now(timezone.utc),
        plan="cmo",
        max_agents=1,
        gateway_token="test-token",
        gateway_token_hash="test-hash",
        current_image="registry.fly.io/openclaw:test",
        provisioning_step=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return UserMachine(**defaults)


@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_user_machine.return_value = None
    mock.create_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning, provisioning_step=0
    )
    mock.update_user_machine.return_value = None
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.create_app.return_value = {"id": "app-id"}
    mock.set_secrets.return_value = None
    mock.create_volume.return_value = {"id": "vol_new123"}
    mock.create_machine.return_value = {"id": "mach_new123"}
    mock.wait_for_state.return_value = None
    return mock


def _make_app(mock_fly, mock_supabase, settings):
    """Uses the shared `settings` fixture from conftest.py."""
    app = FastAPI()
    app.include_router(
        create_provision_router(mock_fly, mock_supabase, settings),
        prefix="/api",
    )
    return TestClient(app)


def test_provision_new_user(mock_fly, mock_supabase, settings):
    """Fresh provisioning creates app, volume, machine."""
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1", "plan": "cmo"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "provisioned"
    mock_fly.create_app.assert_called_once()
    mock_fly.set_secrets.assert_called_once()
    mock_fly.create_volume.assert_called_once()
    mock_fly.create_machine.assert_called_once()


def test_provision_already_running(mock_fly, mock_supabase, settings):
    """Returns 200 with already_running if machine exists and is running."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.running
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "already_running"
    mock_fly.create_app.assert_not_called()


def test_provision_resumes_from_step(mock_fly, mock_supabase, settings):
    """Resumes from provisioning_step if machine is in provisioning state."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning,
        provisioning_step=2,  # App + secrets already done
        fly_volume_id=None,
        fly_machine_id=None,
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    # Should NOT create app or set secrets again
    mock_fly.create_app.assert_not_called()
    mock_fly.set_secrets.assert_not_called()
    # Should create volume and machine
    mock_fly.create_volume.assert_called_once()
    mock_fly.create_machine.assert_called_once()


def test_provision_marks_failed_on_error(mock_fly, mock_supabase, settings):
    """Sets status to failed if any step raises."""
    mock_fly.create_app.side_effect = Exception("Fly API error")
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 500
    # Should have set status to failed
    mock_supabase.update_user_machine.assert_called()
    call_kwargs = mock_supabase.update_user_machine.call_args
    assert call_kwargs[1].get("status") == MachineStatus.failed.value
