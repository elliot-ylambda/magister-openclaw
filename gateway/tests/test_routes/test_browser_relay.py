"""Tests for browser relay policy engine."""

import pytest
from app.routes.browser_relay import check_policy, is_url_allowed, derive_relay_token


class TestIsUrlAllowed:
    def test_empty_allowlist_allows_all(self):
        assert is_url_allowed("https://anything.com", []) is True

    def test_exact_domain_match(self):
        assert is_url_allowed("https://google.com/ads", ["google.com"]) is True

    def test_subdomain_match(self):
        assert is_url_allowed("https://ads.google.com", ["google.com"]) is True

    def test_blocked_domain(self):
        assert is_url_allowed("https://wellsfargo.com", ["google.com"]) is False

    def test_partial_match_rejected(self):
        assert is_url_allowed("https://notgoogle.com", ["google.com"]) is False

    def test_multiple_domains(self):
        urls = ["google.com", "facebook.com"]
        assert is_url_allowed("https://facebook.com/page", urls) is True
        assert is_url_allowed("https://twitter.com", urls) is False

    def test_invalid_url_blocked(self):
        assert is_url_allowed("not-a-url", ["google.com"]) is False


class TestCheckPolicy:
    def test_allows_non_cdp_frames(self):
        msg = {"method": "pong"}
        allowed, _ = check_policy(msg, read_only=True, allowed_urls=["x.com"])
        assert allowed is True

    def test_blocks_input_in_readonly(self):
        msg = {"method": "forwardCDPCommand", "params": {"method": "Input.dispatchMouseEvent"}}
        allowed, reason = check_policy(msg, read_only=True, allowed_urls=[])
        assert allowed is False
        assert "read-only" in reason

    def test_allows_screenshot_in_readonly(self):
        msg = {"method": "forwardCDPCommand", "params": {"method": "Page.captureScreenshot"}}
        allowed, _ = check_policy(msg, read_only=True, allowed_urls=[])
        assert allowed is True

    def test_blocks_runtime_evaluate_in_readonly(self):
        msg = {"method": "forwardCDPCommand", "params": {"method": "Runtime.evaluate"}}
        allowed, _ = check_policy(msg, read_only=True, allowed_urls=[])
        assert allowed is False

    def test_blocks_navigate_to_disallowed_url(self):
        msg = {
            "method": "forwardCDPCommand",
            "params": {"method": "Page.navigate", "params": {"url": "https://wellsfargo.com"}},
        }
        allowed, reason = check_policy(msg, read_only=False, allowed_urls=["google.com"])
        assert allowed is False
        assert "allowlist" in reason

    def test_allows_navigate_to_allowed_url(self):
        msg = {
            "method": "forwardCDPCommand",
            "params": {"method": "Page.navigate", "params": {"url": "https://ads.google.com"}},
        }
        allowed, _ = check_policy(msg, read_only=False, allowed_urls=["google.com"])
        assert allowed is True

    def test_allows_navigate_when_no_allowlist(self):
        msg = {
            "method": "forwardCDPCommand",
            "params": {"method": "Page.navigate", "params": {"url": "https://anything.com"}},
        }
        allowed, _ = check_policy(msg, read_only=False, allowed_urls=[])
        assert allowed is True

    def test_blocks_create_target_disallowed_url(self):
        msg = {
            "method": "forwardCDPCommand",
            "params": {"method": "Target.createTarget", "params": {"url": "https://evil.com"}},
        }
        allowed, reason = check_policy(msg, read_only=False, allowed_urls=["google.com"])
        assert allowed is False
        assert "allowlist" in reason

    def test_blocks_dom_mutation_in_readonly(self):
        msg = {"method": "forwardCDPCommand", "params": {"method": "DOM.setAttributeValue"}}
        allowed, reason = check_policy(msg, read_only=True, allowed_urls=[])
        assert allowed is False

    def test_allows_page_enable_in_readonly(self):
        msg = {"method": "forwardCDPCommand", "params": {"method": "Page.enable"}}
        allowed, _ = check_policy(msg, read_only=True, allowed_urls=[])
        assert allowed is True


class TestDeriveRelayToken:
    def test_produces_hex_string(self):
        token = derive_relay_token("test-gateway-token", 18792)
        assert isinstance(token, str)
        assert len(token) == 64  # SHA-256 hex

    def test_deterministic(self):
        t1 = derive_relay_token("my-token", 18792)
        t2 = derive_relay_token("my-token", 18792)
        assert t1 == t2

    def test_different_tokens_differ(self):
        t1 = derive_relay_token("token-a", 18792)
        t2 = derive_relay_token("token-b", 18792)
        assert t1 != t2
