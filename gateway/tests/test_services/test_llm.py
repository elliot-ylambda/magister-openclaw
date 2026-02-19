"""Tests for LLMService — mocks litellm, no real API calls."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.llm import LLMService, MODEL_COSTS, CACHE_TTL_SECONDS


# ── Fixtures ─────────────────────────────────────────────────────

@pytest.fixture
def mock_supabase():
    mock = AsyncMock()
    mock.get_monthly_llm_spend.return_value = 0
    mock.insert_usage_event.return_value = None
    return mock


@pytest.fixture
def llm_service(mock_supabase):
    return LLMService(
        anthropic_api_key="test-key",
        supabase=mock_supabase,
        plan_budgets={"cmo": 5000, "cmo_plus": 15000},
        plan_allowed_models={
            "cmo": ["claude-sonnet-4-6", "claude-haiku-4-5"],
            "cmo_plus": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
        },
    )


# ── Budget Checks ───────────────────────────────────────────────

class TestCheckBudget:
    async def test_within_budget(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 2000

        result = await llm_service.check_budget("u1", "cmo")

        assert result is True  # 2000 < 5000

    async def test_over_budget(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 5500

        result = await llm_service.check_budget("u1", "cmo")

        assert result is False  # 5500 >= 5000

    async def test_at_exact_budget_is_over(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 5000

        result = await llm_service.check_budget("u1", "cmo")

        assert result is False  # 5000 is not < 5000


# ── Model Validation ────────────────────────────────────────────

class TestValidateModel:
    def test_sonnet_allowed_on_cmo(self, llm_service):
        assert llm_service.validate_model("claude-sonnet-4-6", "cmo") is True

    def test_haiku_allowed_on_cmo(self, llm_service):
        assert llm_service.validate_model("claude-haiku-4-5", "cmo") is True

    def test_opus_blocked_on_cmo(self, llm_service):
        assert llm_service.validate_model("claude-opus-4-6", "cmo") is False

    def test_opus_allowed_on_cmo_plus(self, llm_service):
        assert llm_service.validate_model("claude-opus-4-6", "cmo_plus") is True

    def test_unknown_model_blocked(self, llm_service):
        assert llm_service.validate_model("gpt-4o", "cmo") is False

    def test_unknown_plan_blocks_all(self, llm_service):
        assert llm_service.validate_model("claude-sonnet-4-6", "free") is False


# ── Cost Calculation ─────────────────────────────────────────────

class TestCalculateCost:
    def test_uses_ceil_and_minimum_one_cent(self):
        # 1 input token of sonnet: 300 / 1M = 0.0003 cents → ceil = 1
        cost = LLMService._calculate_cost("claude-sonnet-4-6", 1, 0)
        assert cost == 1

    def test_real_usage_sonnet(self):
        # 1000 input + 500 output for sonnet:
        # input: 1000 * 300 / 1M = 0.3
        # output: 500 * 1500 / 1M = 0.75
        # total: 1.05 → ceil = 2
        cost = LLMService._calculate_cost("claude-sonnet-4-6", 1000, 500)
        assert cost == 2

    def test_unknown_model_returns_one_cent(self):
        cost = LLMService._calculate_cost("unknown-model", 1000, 500)
        assert cost == 1

    def test_opus_expensive(self):
        # 10000 input + 5000 output for opus:
        # input: 10000 * 1500 / 1M = 15.0
        # output: 5000 * 7500 / 1M = 37.5
        # total: 52.5 → ceil = 53
        cost = LLMService._calculate_cost("claude-opus-4-6", 10000, 5000)
        assert cost == 53


# ── Spend Cache ──────────────────────────────────────────────────

class TestSpendCache:
    async def test_caches_within_ttl(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 1000

        # First call fetches from DB
        spend1 = await llm_service._get_cached_spend("u1")
        assert spend1 == 1000
        assert mock_supabase.get_monthly_llm_spend.call_count == 1

        # Second call uses cache
        spend2 = await llm_service._get_cached_spend("u1")
        assert spend2 == 1000
        assert mock_supabase.get_monthly_llm_spend.call_count == 1  # no new call

    async def test_refetches_after_ttl(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 1000

        # Seed the cache with an expired entry
        llm_service._spend_cache["u1"] = (
            1000,
            time.time() - CACHE_TTL_SECONDS - 1,
        )

        mock_supabase.get_monthly_llm_spend.return_value = 2000
        spend = await llm_service._get_cached_spend("u1")
        assert spend == 2000
        assert mock_supabase.get_monthly_llm_spend.call_count == 1

    async def test_invalidate_clears_cache(self, llm_service, mock_supabase):
        mock_supabase.get_monthly_llm_spend.return_value = 1000
        await llm_service._get_cached_spend("u1")

        llm_service._invalidate_cache("u1")
        assert "u1" not in llm_service._spend_cache


# ── Completion ───────────────────────────────────────────────────

class TestCompletion:
    @patch("app.services.llm.litellm.acompletion", new_callable=AsyncMock)
    async def test_non_streaming_records_usage(
        self, mock_acompletion, llm_service, mock_supabase
    ):
        # Set up mock response with usage
        mock_response = MagicMock()
        mock_response.usage.prompt_tokens = 100
        mock_response.usage.completion_tokens = 50
        mock_acompletion.return_value = mock_response

        result = await llm_service.completion(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "hello"}],
            user_id="u1",
        )

        assert result is mock_response
        mock_acompletion.assert_called_once_with(
            model="anthropic/claude-sonnet-4-6",
            messages=[{"role": "user", "content": "hello"}],
            api_key="test-key",
        )
        # Verify usage event was inserted
        mock_supabase.insert_usage_event.assert_called_once()
        event = mock_supabase.insert_usage_event.call_args[0][0]
        assert event.user_id == "u1"
        assert event.model == "claude-sonnet-4-6"
        assert event.input_tokens == 100
        assert event.output_tokens == 50
        assert event.cost_cents >= 1
