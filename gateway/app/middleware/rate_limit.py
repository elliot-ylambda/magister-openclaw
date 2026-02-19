"""In-memory token bucket rate limiter keyed by user_id."""

from __future__ import annotations

import time

from fastapi import HTTPException


class RateLimiter:
    """Per-user token bucket rate limiter.

    Per-instance only — acceptable for early access with a small number
    of Gateway instances.
    """

    def __init__(self, max_requests: int = 20, window_seconds: float = 60.0) -> None:
        self._max = max_requests
        self._window = window_seconds
        # user_id -> (tokens_remaining, last_refill_timestamp)
        self._buckets: dict[str, tuple[float, float]] = {}

    def check(self, user_id: str) -> None:
        """Consume one token or raise HTTP 429."""
        now = time.monotonic()
        tokens, last_refill = self._buckets.get(user_id, (float(self._max), now))

        # Refill tokens based on elapsed time
        elapsed = now - last_refill
        tokens = min(self._max, tokens + elapsed * (self._max / self._window))
        last_refill = now

        if tokens < 1.0:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        tokens -= 1.0
        self._buckets[user_id] = (tokens, last_refill)

    def cleanup(self) -> None:
        """Remove stale buckets (full buckets older than 2x window)."""
        now = time.monotonic()
        stale = [
            uid
            for uid, (tokens, ts) in self._buckets.items()
            if (now - ts) > self._window * 2
        ]
        for uid in stale:
            del self._buckets[uid]
