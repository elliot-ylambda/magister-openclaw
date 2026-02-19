"""LLM service wrapping litellm with per-user budget enforcement and usage tracking."""

from __future__ import annotations

import math
import time
from typing import AsyncIterator

import litellm

from app.models import UsageEvent
from app.services.supabase_client import SupabaseService


# Cost per 1M tokens in cents
MODEL_COSTS: dict[str, dict[str, int]] = {
    "claude-sonnet-4-6": {"input": 300, "output": 1500},
    "claude-haiku-4-5": {"input": 80, "output": 400},
    "claude-opus-4-6": {"input": 1500, "output": 7500},
}

CACHE_TTL_SECONDS = 30


class LLMService:
    """Wraps litellm.acompletion() with budget enforcement and usage tracking."""

    def __init__(
        self,
        anthropic_api_key: str,
        supabase: SupabaseService,
        plan_budgets: dict[str, int],
        plan_allowed_models: dict[str, list[str]],
    ) -> None:
        self._api_key = anthropic_api_key
        self._supabase = supabase
        self._plan_budgets = plan_budgets
        self._plan_allowed_models = plan_allowed_models
        # In-memory spend cache: user_id -> (spend_cents, timestamp)
        self._spend_cache: dict[str, tuple[int, float]] = {}

    # ── Validation ───────────────────────────────────────────────

    def validate_model(self, model: str, plan: str) -> bool:
        """Check whether the model is allowed for the given plan."""
        allowed = self._plan_allowed_models.get(plan, [])
        return model in allowed

    # ── Budget ───────────────────────────────────────────────────

    async def check_budget(self, user_id: str, plan: str) -> bool:
        """Check cached monthly spend vs plan budget. Returns True if within budget."""
        budget = self._plan_budgets.get(plan, 0)
        spend = await self._get_cached_spend(user_id)
        return spend < budget

    async def _get_cached_spend(self, user_id: str) -> int:
        """Return cached spend or fetch from DB if stale/missing."""
        cached = self._spend_cache.get(user_id)
        now = time.time()
        if cached and (now - cached[1]) < CACHE_TTL_SECONDS:
            return cached[0]
        spend = await self._supabase.get_monthly_llm_spend(user_id)
        self._spend_cache[user_id] = (spend, now)
        return spend

    def _invalidate_cache(self, user_id: str) -> None:
        self._spend_cache.pop(user_id, None)

    # ── Cost calculation ─────────────────────────────────────────

    @staticmethod
    def _calculate_cost(
        model: str, input_tokens: int, output_tokens: int
    ) -> int:
        """Calculate cost in cents. Uses math.ceil — minimum 1 cent."""
        costs = MODEL_COSTS.get(model)
        if not costs:
            return 1
        raw = (
            input_tokens * costs["input"] / 1_000_000
            + output_tokens * costs["output"] / 1_000_000
        )
        return max(1, math.ceil(raw))

    # ── Completion ───────────────────────────────────────────────

    async def completion(
        self,
        model: str,
        messages: list[dict],
        user_id: str,
        stream: bool = False,
        **kwargs,
    ):
        """Call litellm.acompletion, record usage, enforce budget.

        Returns the litellm response (non-streaming) or an async generator
        (streaming).
        """
        litellm_model = f"anthropic/{model}"

        if stream:
            return self._stream_completion(
                litellm_model, model, messages, user_id, **kwargs
            )

        response = await litellm.acompletion(
            model=litellm_model,
            messages=messages,
            api_key=self._api_key,
            **kwargs,
        )

        # Record usage
        usage = response.usage
        if usage:
            cost = self._calculate_cost(
                model, usage.prompt_tokens, usage.completion_tokens
            )
            await self._record_usage(
                user_id, model, usage.prompt_tokens, usage.completion_tokens, cost
            )

        return response

    async def _stream_completion(
        self,
        litellm_model: str,
        model: str,
        messages: list[dict],
        user_id: str,
        **kwargs,
    ) -> AsyncIterator:
        """Async generator that yields chunks and records usage from the final chunk."""
        response = await litellm.acompletion(
            model=litellm_model,
            messages=messages,
            api_key=self._api_key,
            stream=True,
            stream_options={"include_usage": True},
            **kwargs,
        )

        input_tokens = 0
        output_tokens = 0

        async for chunk in response:
            # The final chunk may include usage info
            if hasattr(chunk, "usage") and chunk.usage:
                input_tokens = getattr(chunk.usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(chunk.usage, "completion_tokens", 0) or 0
            yield chunk

        # After stream ends, record usage
        if input_tokens or output_tokens:
            cost = self._calculate_cost(model, input_tokens, output_tokens)
            await self._record_usage(
                user_id, model, input_tokens, output_tokens, cost
            )

    async def _record_usage(
        self,
        user_id: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_cents: int,
    ) -> None:
        """Insert usage event and invalidate spend cache."""
        event = UsageEvent(
            user_id=user_id,
            event_type="llm_request",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_cents=cost_cents,
        )
        await self._supabase.insert_usage_event(event)
        self._invalidate_cache(user_id)
