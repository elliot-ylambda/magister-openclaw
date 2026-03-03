"""Tests for the /api/provision route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

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
    mock.get_user_machine_for_provision.return_value = None
    mock.create_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning, provisioning_step=0
    )
    mock.update_user_machine.return_value = None
    mock.delete_user_machine.return_value = None
    mock.get_merged_secrets_for_user.return_value = {}
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


@pytest.fixture
def mock_httpx_health():
    """Mock httpx.AsyncClient used by step 6 health polling (succeeds immediately)."""
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.routes.provision.httpx.AsyncClient", return_value=mock_client) as mock_cls, \
         patch("app.routes.provision.asyncio.sleep", new_callable=AsyncMock):
        mock_cls._client = mock_client  # expose for assertions
        yield mock_cls


def _make_app(mock_fly, mock_supabase, settings):
    """Uses the shared `settings` fixture from conftest.py."""
    app = FastAPI()
    app.include_router(
        create_provision_router(mock_fly, mock_supabase, settings),
        prefix="/api",
    )
    return TestClient(app)


def test_provision_new_user(mock_fly, mock_supabase, settings, mock_httpx_health):
    """Fresh provisioning creates app, volume, machine, and polls health."""
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1", "plan": "cmo"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "provisioned"
    mock_fly.create_app.assert_called_once()
    mock_fly.set_secrets.assert_called_once()
    mock_fly.create_volume.assert_called_once()
    mock_fly.create_machine.assert_called_once()
    # Step 6: health check was called
    mock_httpx_health._client.get.assert_called()


def test_provision_already_running(mock_fly, mock_supabase, settings):
    """Returns 200 with already_provisioned if machine is running."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
        status=MachineStatus.running
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "already_provisioned"
    mock_fly.create_app.assert_not_called()


def test_provision_resumes_from_step(mock_fly, mock_supabase, settings, mock_httpx_health):
    """Resumes from provisioning_step if machine is in provisioning state."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
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


# ── New state-handling tests ──────────────────────────────────────


def test_provision_failed_resumes(mock_fly, mock_supabase, settings, mock_httpx_health):
    """Failed machine resets to provisioning and resumes from last step."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
        status=MachineStatus.failed,
        provisioning_step=3,  # App + secrets + volume done, machine creation failed
        fly_volume_id="vol_123",
        fly_machine_id=None,
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "provisioned"
    # Should have reset status to provisioning
    mock_supabase.update_user_machine.assert_any_call(
        "machine-1", status=MachineStatus.provisioning.value
    )
    # Should NOT redo steps 1-3
    mock_fly.create_app.assert_not_called()
    mock_fly.set_secrets.assert_not_called()
    mock_fly.create_volume.assert_not_called()
    # Should resume at step 4 (create machine)
    mock_fly.create_machine.assert_called_once()


def test_provision_destroyed_starts_fresh(mock_fly, mock_supabase, settings, mock_httpx_health):
    """Destroyed record is deleted, then a new machine is created from scratch."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
        status=MachineStatus.destroyed,
    )
    # After deleting the ghost, create_user_machine returns a fresh record
    mock_supabase.create_user_machine.return_value = _make_machine(
        id="machine-2",
        status=MachineStatus.provisioning,
        provisioning_step=0,
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "provisioned"
    # Should have deleted the destroyed record
    mock_supabase.delete_user_machine.assert_called_once_with("machine-1")
    # Should have created a fresh record
    mock_supabase.create_user_machine.assert_called_once()
    # Should run all provisioning steps
    mock_fly.create_app.assert_called_once()
    mock_fly.create_machine.assert_called_once()


def test_provision_suspended_returns_success(mock_fly, mock_supabase, settings):
    """Suspended machine returns already_provisioned without touching Fly."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
        status=MachineStatus.suspended,
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "already_provisioned"
    mock_fly.create_app.assert_not_called()


def test_provision_destroying_returns_409(mock_fly, mock_supabase, settings):
    """Machine being destroyed returns 409 Conflict."""
    mock_supabase.get_user_machine_for_provision.return_value = _make_machine(
        status=MachineStatus.destroying,
    )
    client = _make_app(mock_fly, mock_supabase, settings)
    resp = client.post("/api/provision", json={"user_id": "user-1"})
    assert resp.status_code == 409
    mock_fly.create_app.assert_not_called()


# ── Health polling tests ─────────────────────────────────────────


def test_provision_health_timeout_marks_failed(mock_fly, mock_supabase, settings):
    """All 24 health checks fail → machine marked failed, returns 500."""
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = Exception("Connection refused")

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.routes.provision.httpx.AsyncClient", return_value=mock_client), \
         patch("app.routes.provision.asyncio.sleep", new_callable=AsyncMock):
        client = _make_app(mock_fly, mock_supabase, settings)
        resp = client.post("/api/provision", json={"user_id": "user-1", "plan": "cmo"})

    assert resp.status_code == 500
    # Machine should be marked failed
    mock_supabase.update_user_machine.assert_called()
    last_call_kwargs = mock_supabase.update_user_machine.call_args
    assert last_call_kwargs[1].get("status") == MachineStatus.failed.value
