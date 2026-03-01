"""Tests for the /api/status route."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import MachineStatus, UserMachine
from app.routes.status import create_status_router


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
    mock.get_monthly_llm_spend.return_value = 0
    return mock


@pytest.fixture
def mock_fly():
    mock = AsyncMock()
    mock.get_machine.return_value = {"id": "mach_123", "state": "started"}
    return mock


def _make_app(mock_fly, mock_supabase):
    from fastapi import Depends

    app = FastAPI()

    async def fake_jwt():
        return "user-1"

    verify_jwt = Depends(fake_jwt)

    router = create_status_router(mock_fly, mock_supabase, verify_jwt)
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_status_returns_provisioning_step(mock_fly, mock_supabase):
    """Status response includes provisioning_step during provisioning."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.provisioning, provisioning_step=3
    )
    client = _make_app(mock_fly, mock_supabase)
    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["provisioning_step"] == 3


def test_status_provisioning_step_for_running_machine(mock_fly, mock_supabase):
    """Running machine returns provisioning_step=5."""
    mock_supabase.get_user_machine.return_value = _make_machine(
        status=MachineStatus.running, provisioning_step=5
    )
    client = _make_app(mock_fly, mock_supabase)
    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["provisioning_step"] == 5
    assert data["status"] == "running"
