"""Test email-related Supabase service methods."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from app.services.supabase_client import SupabaseService


@pytest.fixture
def mock_supabase():
    """Create a mock SupabaseService with a mocked _client."""
    service = SupabaseService.__new__(SupabaseService)
    service._client = MagicMock()
    return service


@pytest.mark.asyncio
async def test_get_machine_by_email(mock_supabase):
    mock_result = MagicMock()
    mock_result.data = {"id": "machine-1", "user_id": "user-1", "email_address": "agent-user1@agent.magistermarketing.com"}
    mock_supabase._client.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute = AsyncMock(return_value=mock_result)
    result = await mock_supabase.get_machine_by_email("agent-user1@agent.magistermarketing.com")
    assert result is not None
    assert result["email_address"] == "agent-user1@agent.magistermarketing.com"


@pytest.mark.asyncio
async def test_create_agent_email(mock_supabase):
    mock_result = MagicMock()
    mock_result.data = [{"id": "email-1", "status": "pending", "direction": "outbound"}]
    mock_supabase._client.table.return_value.insert.return_value.execute = AsyncMock(return_value=mock_result)
    result = await mock_supabase.create_agent_email({
        "user_id": "user-1", "machine_id": "machine-1", "direction": "outbound",
        "status": "pending", "from_address": "agent@test.com", "to_address": "client@test.com",
        "subject": "Hello", "body_html": "<p>Hi</p>",
    })
    assert result["status"] == "pending"


@pytest.mark.asyncio
async def test_update_agent_email_status(mock_supabase):
    mock_result = MagicMock()
    mock_result.data = [{"id": "email-1", "status": "approved"}]
    mock_supabase._client.table.return_value.update.return_value.eq.return_value.execute = AsyncMock(return_value=mock_result)
    result = await mock_supabase.update_agent_email("email-1", status="approved")
    assert result["status"] == "approved"
