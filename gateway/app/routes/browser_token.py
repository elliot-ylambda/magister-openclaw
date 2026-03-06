"""Browser extension connection token generate/exchange endpoints."""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.supabase_client import SupabaseService

TOKEN_EXPIRY_MINUTES = 10
GATEWAY_JWT_EXPIRY_SECONDS = 30 * 24 * 3600  # 30 days


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
    async def exchange_token(req: TokenExchangeRequest):
        record = await supabase.get_browser_token(req.token)
        if not record:
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
