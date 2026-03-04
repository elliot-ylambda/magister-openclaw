"""LLM service wrapping litellm with per-user budget enforcement and usage tracking."""

from __future__ import annotations

import math
import time
from typing import AsyncIterator

import litellm

from app.models import UsageEvent
from app.services.supabase_client import SupabaseService


# Cost per 1M tokens in cents (OpenRouter pricing includes ~5.5% platform fee)
MODEL_COSTS: dict[str, dict[str, int]] = {
    # Prefixed format (OpenRouter path)
    "anthropic/claude-sonnet-4-6": {"input": 317, "output": 1583},
    "anthropic/claude-haiku-4-5":  {"input": 106, "output": 528},
    "anthropic/claude-opus-4-6":   {"input": 1583, "output": 7913},
    "openai/gpt-4o":               {"input": 264, "output": 1055},
    "google/gemini-2.5-flash":     {"input": 32, "output": 158},
    "google/gemini-2.5-pro":       {"input": 132, "output": 528},
}

CACHE_TTL_SECONDS = 30

# kwargs that must never be forwarded from the request body to litellm.
# Prevents callers from overriding credentials, routing, or provider selection.
_BLOCKED_KWARGS = frozenset({
    "api_key", "api_base", "base_url", "api_version",
    "custom_llm_provider", "model", "stream_options",
})


def _sanitize_kwargs(kwargs: dict) -> dict:
    """Strip security-sensitive keys from the litellm kwargs dict."""
    for key in _BLOCKED_KWARGS:
        kwargs.pop(key, None)
    return kwargs


# Model prefix → (byok_provider_key, litellm_prefix) mapping for direct BYOK keys.
# Models arrive as "google/gemini-2.5-flash" but the BYOK key is stored under "gemini".
_MODEL_PREFIX_MAP: dict[str, tuple[str, str]] = {
    "anthropic": ("anthropic", "anthropic"),
    "openai": ("openai", "openai"),
    "google": ("gemini", "gemini"),
}


def resolve_byok_key(
    model: str, byok_keys: dict[str, str]
) -> tuple[str, str | None]:
    """Resolve which API key and litellm model string to use for a request.

    Returns (litellm_model, api_key_or_None). If api_key is None, the caller
    should use the platform OpenRouter key.
    """
    if not byok_keys:
        return f"openrouter/{model}", None

    # Extract provider from model name (e.g. "google/gemini-2.5-flash" → "google")
    model_prefix = model.split("/")[0] if "/" in model else ""

    # Priority 1: direct provider key
    if model_prefix in _MODEL_PREFIX_MAP:
        byok_provider, litellm_prefix = _MODEL_PREFIX_MAP[model_prefix]
        if byok_provider in byok_keys:
            model_name = model.split("/", 1)[1]
            return f"{litellm_prefix}/{model_name}", byok_keys[byok_provider]

    # Priority 2: OpenRouter fallback
    if "openrouter" in byok_keys:
        return f"openrouter/{model}", byok_keys["openrouter"]

    # No BYOK match — use platform key
    return f"openrouter/{model}", None


class LLMService:
    """Wraps litellm.acompletion() with budget enforcement and usage tracking."""

    def __init__(
        self,
        openrouter_api_key: str,
        supabase: SupabaseService,
        plan_budgets: dict[str, int],
        plan_allowed_models: dict[str, list[str]],
    ) -> None:
        self._openrouter_key = openrouter_api_key
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
        byok_keys: dict[str, str] | None = None,
        **kwargs,
    ):
        """Call litellm.acompletion, record usage, enforce budget.

        Returns the litellm response (non-streaming) or an async generator
        (streaming).
        """
        _sanitize_kwargs(kwargs)
        litellm_model, byok_key = resolve_byok_key(model, byok_keys or {})
        is_byok = byok_key is not None
        api_key = byok_key if is_byok else self._openrouter_key

        if stream:
            return self._stream_completion(
                litellm_model, model, messages, user_id,
                api_key=api_key, is_byok=is_byok, **kwargs,
            )

        response = await litellm.acompletion(
            model=litellm_model,
            messages=messages,
            api_key=api_key,
            **kwargs,
        )

        # Record usage
        usage = response.usage
        if usage:
            cost = self._calculate_cost(
                model, usage.prompt_tokens, usage.completion_tokens
            )
            await self._record_usage(
                user_id, model, usage.prompt_tokens, usage.completion_tokens, cost,
                is_byok=is_byok,
            )

        return response

    async def _stream_completion(
        self,
        litellm_model: str,
        model: str,
        messages: list[dict],
        user_id: str,
        *,
        api_key: str,
        is_byok: bool = False,
        **kwargs,
    ) -> AsyncIterator:
        """Async generator that yields chunks and records usage from the final chunk."""
        response = await litellm.acompletion(
            model=litellm_model,
            messages=messages,
            api_key=api_key,
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
                user_id, model, input_tokens, output_tokens, cost,
                is_byok=is_byok,
            )

    async def _record_usage(
        self,
        user_id: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_cents: int,
        *,
        is_byok: bool = False,
    ) -> None:
        """Insert usage event and invalidate spend cache."""
        event = UsageEvent(
            user_id=user_id,
            event_type="llm_request",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_cents=0 if is_byok else cost_cents,
            metadata={"byok": True} if is_byok else None,
        )
        await self._supabase.insert_usage_event(event)
        if not is_byok:
            self._invalidate_cache(user_id)
