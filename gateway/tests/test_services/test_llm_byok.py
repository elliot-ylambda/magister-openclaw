"""Tests for BYOK key resolution logic in the LLM service."""

from __future__ import annotations

import pytest

from app.services.llm import resolve_byok_key


class TestResolveByokKey:
    """Tests for resolve_byok_key()."""

    def test_no_keys_returns_platform_routing(self):
        """No BYOK keys → openrouter/ prefix, None key."""
        model, key = resolve_byok_key("anthropic/claude-sonnet-4-6", {})
        assert model == "openrouter/anthropic/claude-sonnet-4-6"
        assert key is None

    def test_direct_anthropic(self):
        """Anthropic key → model stays as anthropic/, user key returned."""
        model, key = resolve_byok_key(
            "anthropic/claude-sonnet-4-6",
            {"anthropic": "sk-ant-test-key"},
        )
        assert model == "anthropic/claude-sonnet-4-6"
        assert key == "sk-ant-test-key"

    def test_direct_openai(self):
        """OpenAI key → model stays as openai/, user key returned."""
        model, key = resolve_byok_key(
            "openai/gpt-4o",
            {"openai": "sk-openai-test-key"},
        )
        assert model == "openai/gpt-4o"
        assert key == "sk-openai-test-key"

    def test_direct_gemini_remaps_prefix(self):
        """Gemini key + google/ model → remaps to gemini/ prefix for litellm."""
        model, key = resolve_byok_key(
            "google/gemini-2.5-flash",
            {"gemini": "AIza-test-key"},
        )
        assert model == "gemini/gemini-2.5-flash"
        assert key == "AIza-test-key"

    def test_openrouter_fallback(self):
        """OpenRouter key used when no direct provider key matches."""
        model, key = resolve_byok_key(
            "anthropic/claude-sonnet-4-6",
            {"openrouter": "sk-or-test-key"},
        )
        assert model == "openrouter/anthropic/claude-sonnet-4-6"
        assert key == "sk-or-test-key"

    def test_direct_key_takes_priority_over_openrouter(self):
        """Direct provider key wins when both direct and openrouter keys exist."""
        model, key = resolve_byok_key(
            "anthropic/claude-sonnet-4-6",
            {"anthropic": "sk-ant-direct", "openrouter": "sk-or-fallback"},
        )
        assert model == "anthropic/claude-sonnet-4-6"
        assert key == "sk-ant-direct"

    def test_unmatched_provider_uses_openrouter_fallback(self):
        """Model from unmatched provider falls back to openrouter key."""
        model, key = resolve_byok_key(
            "meta/llama-3-70b",
            {"anthropic": "sk-ant-test", "openrouter": "sk-or-test"},
        )
        assert model == "openrouter/meta/llama-3-70b"
        assert key == "sk-or-test"

    def test_unmatched_provider_no_openrouter_returns_none(self):
        """Model from unmatched provider with no openrouter key → platform key."""
        model, key = resolve_byok_key(
            "meta/llama-3-70b",
            {"anthropic": "sk-ant-test"},
        )
        assert model == "openrouter/meta/llama-3-70b"
        assert key is None
