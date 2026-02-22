"""Authentication dependencies for the Gateway API.

Three auth paths:
- JWT (Supabase)  — user-facing routes (/api/chat, /api/status)
- API Key         — internal routes called by Vercel webhook (/api/provision, /api/destroy)
- Machine Token   — OpenClaw calling the LLM proxy (/llm/v1/chat/completions)
"""

from __future__ import annotations

import hashlib
import hmac

from fastapi import Depends, HTTPException, Request


def hash_token(token: str) -> str:
    """SHA-256 hash of a bearer token."""
    return hashlib.sha256(token.encode()).hexdigest()


def _extract_bearer(request: Request) -> str:
    """Extract bearer token from Authorization header or raise 401."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return auth[7:]


# ── JWT Auth (Supabase) ──────────────────────────────────────


def create_jwt_dependency(jwt_secret: str):
    """Factory: returns a FastAPI Depends that decodes a Supabase JWT and returns user_id."""
    from jose import JWTError, jwt as jose_jwt

    async def verify_jwt(request: Request) -> str:
        token = _extract_bearer(request)
        try:
            payload = jose_jwt.decode(
                token,
                jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        except JWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="JWT missing sub claim")
        return user_id

    return Depends(verify_jwt)


# ── API Key Auth ─────────────────────────────────────────────


def create_api_key_dependency(api_key: str):
    """Factory: returns a FastAPI Depends that validates GATEWAY_API_KEY (guard only)."""

    async def verify_api_key(request: Request) -> None:
        token = _extract_bearer(request)
        if not hmac.compare_digest(token, api_key):
            raise HTTPException(status_code=401, detail="Invalid API key")

    return Depends(verify_api_key)


# ── Machine Token Auth ───────────────────────────────────────


async def verify_machine_token(request: Request) -> str:
    """Dependency: extract bearer token and return its SHA-256 hash."""
    token = _extract_bearer(request)
    return hash_token(token)
