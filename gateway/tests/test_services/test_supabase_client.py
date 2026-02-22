"""Tests for SupabaseService — mocks the Supabase AsyncClient internals."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models import MachineStatus, UsageEvent, UserMachine
from app.services.supabase_client import SupabaseService


# ── Helpers ──────────────────────────────────────────────────────

def _make_query_mock(data):
    """Build a chainable mock that ends with .execute() returning data."""
    result = MagicMock()
    result.data = data

    execute = AsyncMock(return_value=result)

    chain = MagicMock()
    # Every chained method returns the same chain so .select().eq().neq() works
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.neq.return_value = chain
    chain.maybe_single.return_value = chain
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.execute = execute
    return chain


def _make_rpc_mock(data):
    """Build a mock for .rpc().execute()."""
    result = MagicMock()
    result.data = data

    rpc_chain = MagicMock()
    rpc_chain.execute = AsyncMock(return_value=result)
    return rpc_chain


_MACHINE_ROW = {
    "id": "m1",
    "user_id": "u1",
    "fly_app_name": "app-u1",
    "fly_machine_id": "mach1",
    "fly_volume_id": "vol1",
    "fly_region": "iad",
    "status": "running",
    "last_activity": None,
    "plan": "cmo",
    "max_agents": 1,
    "gateway_token": "tok",
    "gateway_token_hash": "hash123",
    "pending_image": None,
    "current_image": "img:latest",
    "provisioning_step": 0,
    "created_at": None,
    "updated_at": None,
}


# ── Fixture ──────────────────────────────────────────────────────

@pytest.fixture
def svc():
    """SupabaseService with a fully mocked AsyncClient."""
    mock_client = MagicMock()
    return SupabaseService(mock_client), mock_client


# ── Tests ────────────────────────────────────────────────────────

class TestGetUserMachine:
    async def test_returns_user_machine(self, svc):
        service, client = svc
        client.table.return_value = _make_query_mock(_MACHINE_ROW)

        result = await service.get_user_machine("u1")

        assert isinstance(result, UserMachine)
        assert result.user_id == "u1"
        assert result.status == MachineStatus.running

    async def test_returns_none_when_not_found(self, svc):
        service, client = svc
        client.table.return_value = _make_query_mock(None)

        result = await service.get_user_machine("unknown")
        assert result is None

    async def test_excludes_destroyed_machines(self, svc):
        """Verify the query chains .neq('status', 'destroyed')."""
        service, client = svc
        chain = _make_query_mock(None)
        client.table.return_value = chain

        await service.get_user_machine("u1")

        chain.neq.assert_called_with("status", "destroyed")


class TestGetUserMachineByTokenHash:
    async def test_returns_machine_for_known_hash(self, svc):
        service, client = svc
        client.table.return_value = _make_query_mock(_MACHINE_ROW)

        result = await service.get_user_machine_by_token_hash("hash123")
        assert isinstance(result, UserMachine)

    async def test_returns_none_for_unknown_hash(self, svc):
        service, client = svc
        client.table.return_value = _make_query_mock(None)

        result = await service.get_user_machine_by_token_hash("nope")
        assert result is None


class TestInsertUsageEvent:
    async def test_calls_insert_with_correct_shape(self, svc):
        service, client = svc
        chain = _make_query_mock(None)
        client.table.return_value = chain

        event = UsageEvent(
            user_id="u1",
            event_type="llm_request",
            model="claude-sonnet-4-6",
            input_tokens=100,
            output_tokens=50,
            cost_cents=5,
        )
        await service.insert_usage_event(event)

        client.table.assert_called_with("usage_events")
        inserted = chain.insert.call_args[0][0]
        assert inserted["user_id"] == "u1"
        assert inserted["event_type"] == "llm_request"
        assert inserted["model"] == "claude-sonnet-4-6"
        assert inserted["input_tokens"] == 100
        assert inserted["output_tokens"] == 50
        assert inserted["cost_cents"] == 5
        # None fields excluded by exclude_none
        assert "duration_ms" not in inserted
        assert "metadata" not in inserted


class TestGetMonthlyLlmSpend:
    async def test_calls_rpc_with_correct_param(self, svc):
        service, client = svc
        rpc_chain = _make_rpc_mock(2500)
        client.rpc.return_value = rpc_chain

        result = await service.get_monthly_llm_spend("u1")

        assert result == 2500
        client.rpc.assert_called_with(
            "get_monthly_llm_spend",
            {"p_user_id": "u1"},
        )

    async def test_returns_zero_when_no_spend(self, svc):
        service, client = svc
        rpc_chain = _make_rpc_mock(0)
        client.rpc.return_value = rpc_chain

        result = await service.get_monthly_llm_spend("u1")
        assert result == 0


class TestClaimIdleMachines:
    async def test_returns_list_of_machines(self, svc):
        service, client = svc
        rpc_chain = _make_rpc_mock([_MACHINE_ROW])
        client.rpc.return_value = rpc_chain

        result = await service.claim_idle_machines("30 minutes")

        assert len(result) == 1
        assert isinstance(result[0], UserMachine)

    async def test_returns_empty_list_when_none_idle(self, svc):
        service, client = svc
        rpc_chain = _make_rpc_mock([])
        client.rpc.return_value = rpc_chain

        result = await service.claim_idle_machines("30 minutes")
        assert result == []


class TestCreateUserMachine:
    async def test_returns_created_machine(self, svc):
        service, client = svc
        chain = _make_query_mock([_MACHINE_ROW])
        client.table.return_value = chain

        result = await service.create_user_machine(_MACHINE_ROW)

        assert isinstance(result, UserMachine)
        assert result.id == "m1"
        client.table.assert_called_with("user_machines")
