"""Tests for FlyClient — mocks httpx.AsyncClient internals."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.fly import FlyClient, BACKOFF_BASE


# ── Helpers ──────────────────────────────────────────────────────

def _ok_response(data: dict | None = None, status: int = 200) -> httpx.Response:
    content = b"" if data is None else __import__("json").dumps(data).encode()
    resp = httpx.Response(status_code=status, content=content)
    return resp


def _error_response(status: int, body: str = "error") -> httpx.Response:
    return httpx.Response(status_code=status, content=body.encode())


# ── Fixture ──────────────────────────────────────────────────────

@pytest.fixture
def fly():
    client = FlyClient(api_token="test-token", org="test-org")
    # Replace the internal httpx client with a mock
    client._http = AsyncMock(spec=httpx.AsyncClient)
    return client


# ── App Operations ───────────────────────────────────────────────

class TestCreateApp:
    async def test_sends_correct_json(self, fly):
        fly._http.request = AsyncMock(
            return_value=_ok_response({"id": "app123"})
        )

        result = await fly.create_app("my-app")

        fly._http.request.assert_called_once_with(
            "POST",
            "/apps",
            json={"app_name": "my-app", "org_slug": "test-org"},
        )
        assert result == {"id": "app123"}


# ── Machine Operations ──────────────────────────────────────────

class TestSuspendMachine:
    async def test_hits_correct_url_path(self, fly):
        fly._http.request = AsyncMock(return_value=_ok_response({}))

        await fly.suspend_machine("my-app", "mach123")

        fly._http.request.assert_called_once_with(
            "POST",
            "/apps/my-app/machines/mach123/suspend",
            json=None,
        )


# ── Retry Logic ─────────────────────────────────────────────────

class TestRequestRetry:
    async def test_retries_on_5xx_then_succeeds(self, fly):
        """Verify _request retries on 500 and succeeds on second call."""
        fly._http.request = AsyncMock(
            side_effect=[
                _error_response(500, "Internal Server Error"),
                _ok_response({"ok": True}),
            ]
        )

        with patch("app.services.fly.asyncio.sleep", new_callable=AsyncMock):
            result = await fly._request("GET", "/test")

        assert result == {"ok": True}
        assert fly._http.request.call_count == 2

    async def test_raises_on_4xx_without_retry(self, fly):
        """4xx errors should raise immediately, no retry."""
        fly._http.request = AsyncMock(
            return_value=_error_response(404, "Not Found")
        )

        with pytest.raises(Exception, match="404"):
            await fly._request("GET", "/missing")

        assert fly._http.request.call_count == 1

    async def test_retries_on_timeout(self, fly):
        fly._http.request = AsyncMock(
            side_effect=[
                httpx.TimeoutException("timed out"),
                _ok_response({"ok": True}),
            ]
        )

        with patch("app.services.fly.asyncio.sleep", new_callable=AsyncMock):
            result = await fly._request("GET", "/slow")

        assert result == {"ok": True}
        assert fly._http.request.call_count == 2

    async def test_raises_after_max_retries(self, fly):
        fly._http.request = AsyncMock(
            side_effect=[
                _error_response(500, "fail"),
                _error_response(500, "fail"),
                _error_response(500, "fail"),
            ]
        )

        with patch("app.services.fly.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(Exception, match="500"):
                await fly._request("GET", "/always-fails")

        assert fly._http.request.call_count == 3


# ── Wait for State ───────────────────────────────────────────────

class TestWaitForState:
    async def test_times_out_and_raises(self, fly):
        fly._http.request = AsyncMock(
            return_value=_ok_response({"state": "stopped"})
        )

        with patch("app.services.fly.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(TimeoutError, match="did not reach 'started'"):
                await fly.wait_for_state(
                    "my-app", "mach1", "started", timeout_s=2
                )

    async def test_returns_when_state_reached(self, fly):
        fly._http.request = AsyncMock(
            side_effect=[
                _ok_response({"state": "stopped"}),
                _ok_response({"state": "starting"}),
                _ok_response({"state": "started"}),
            ]
        )

        with patch("app.services.fly.asyncio.sleep", new_callable=AsyncMock):
            result = await fly.wait_for_state(
                "my-app", "mach1", "started", timeout_s=10
            )

        assert result == {"state": "started"}
