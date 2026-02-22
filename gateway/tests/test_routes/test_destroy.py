"""Tests for the /api/destroy route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import MachineStatus, UserMachine
from app.routes.destroy import create_destroy_router


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


def _make_app(mock_fly, mock_supabase):
    app = FastAPI()
    app.include_router(
        create_destroy_router(mock_fly, mock_supabase),
        prefix="/api",
    )
    return TestClient(app)


def test_destroy_no_machine(mock_fly, mock_supabase):
    """Returns 404 if no machine found."""
    client = _make_app(mock_fly, mock_supabase)
    resp = client.post("/api/destroy", json={"user_id": "user-1"})
    assert resp.status_code == 404


def test_destroy_success(mock_fly, mock_supabase):
    """Tears down all resources and marks destroyed."""
    mock_supabase.get_user_machine.return_value = _make_machine()
    client = _make_app(mock_fly, mock_supabase)
    resp = client.post("/api/destroy", json={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "destroyed"
    mock_fly.stop_machine.assert_called_once()
    mock_fly.delete_machine.assert_called_once()
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()


def test_destroy_continues_on_partial_failure(mock_fly, mock_supabase):
    """Continues tearing down even if individual steps fail."""
    mock_supabase.get_user_machine.return_value = _make_machine()
    mock_fly.stop_machine.side_effect = Exception("stop failed")
    mock_fly.delete_machine.side_effect = Exception("delete failed")
    client = _make_app(mock_fly, mock_supabase)
    resp = client.post("/api/destroy", json={"user_id": "user-1"})
    # Should still succeed — destroy is defensive
    assert resp.status_code == 200
    assert resp.json()["status"] == "destroyed"
    # Volume and app deletion should still be attempted
    mock_fly.delete_volume.assert_called_once()
    mock_fly.delete_app.assert_called_once()


def test_destroy_no_fly_resources(mock_fly, mock_supabase):
    """Handles machines with no Fly machine/volume IDs (early provision failure)."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        fly_machine_id=None, fly_volume_id=None
    )
    client = _make_app(mock_fly, mock_supabase)
    resp = client.post("/api/destroy", json={"user_id": "user-1"})
    assert resp.status_code == 200
    # Should skip machine/volume deletion, only delete app
    mock_fly.stop_machine.assert_not_called()
    mock_fly.delete_machine.assert_not_called()
    mock_fly.delete_volume.assert_not_called()
    mock_fly.delete_app.assert_called_once()
