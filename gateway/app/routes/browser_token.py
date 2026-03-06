"""Browser extension connection token generate/exchange endpoints."""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services.supabase_client import SupabaseService

TOKEN_EXPIRY_MINUTES = 10
GATEWAY_JWT_EXPIRY_SECONDS = 30 * 24 * 3600  # 30 days
MAX_EXCHANGE_FAILURES = 5
EXCHANGE_WINDOW_SECONDS = 300  # 5 minutes

# In-memory tracker: client IP → list of failure timestamps
_exchange_failures: dict[str, list[float]] = {}


class TokenExchangeRequest(BaseModel):
    token: str


def create_browser_token_router(
    supabase: SupabaseService,
    verify_jwt,
    jwt_secret: str,
) -> APIRouter:
    router = APIRouter()

    @router.post("/browser/token/generate")
    async def generate_token(user_id: str = verify_jwt):
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRY_MINUTES)
        await supabase.create_browser_token(user_id, token, expires_at)
        return {"token": token, "expires_at": expires_at.isoformat()}

    @router.post("/browser/token/exchange")
    async def exchange_token(request: Request, req: TokenExchangeRequest):
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        cutoff = now - EXCHANGE_WINDOW_SECONDS

        # Clean stale entries and check failure count
        failures = _exchange_failures.get(client_ip, [])
        failures = [t for t in failures if t > cutoff]
        _exchange_failures[client_ip] = failures

        if len(failures) >= MAX_EXCHANGE_FAILURES:
            raise HTTPException(
                status_code=429,
                detail="Too many failed attempts. Try again later.",
            )

        record = await supabase.get_browser_token(req.token)
        if not record:
            _exchange_failures[client_ip].append(now)
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        await supabase.mark_browser_token_used(record["id"])
        payload = {
            "sub": record["user_id"],
            "aud": "authenticated",
            "scope": "browser_relay",
            "iat": int(time.time()),
            "exp": int(time.time()) + GATEWAY_JWT_EXPIRY_SECONDS,
        }
        gateway_jwt = pyjwt.encode(payload, jwt_secret, algorithm="HS256")
        return {"jwt": gateway_jwt}

    return router
