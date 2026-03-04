"""Model selection endpoints: list available models, switch model, admin default.

Dual auth: JWT (user-facing) or API key (admin).
"""

from __future__ import annotations

import hmac
import logging

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.config import SWITCHABLE_MODELS, SWITCHABLE_MODEL_IDS, Settings
from app.models import SetModelRequest
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.model_selection")


class AdminDefaultModelRequest(BaseModel):
    model: str


def create_model_selection_router(
    supabase: SupabaseService,
    settings: Settings,
    *,
    jwt_secret: str,
    api_key: str,
    supabase_url: str = "",
) -> APIRouter:
    router = APIRouter()

    # Set up JWKS client for ES256 verification
    jwks_client = None
    if supabase_url:
        from jwt import PyJWKClient

        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)

    async def resolve_user(request: Request, body_user_id: str | None = None) -> str:
        """Resolve user_id from JWT or API key auth."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = auth[7:]

        if hmac.compare_digest(token, api_key):
            if not body_user_id:
                raise HTTPException(
                    status_code=400, detail="user_id required for admin calls"
                )
            return body_user_id

        try:
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg", "HS256")

            if alg == "ES256" and jwks_client:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = pyjwt.decode(
                    token,
                    signing_key.key,
                    algorithms=["ES256"],
                    audience="authenticated",
                )
            else:
                payload = pyjwt.decode(
                    token,
                    jwt_secret,
                    algorithms=["HS256"],
                    audience="authenticated",
                )
        except pyjwt.exceptions.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="JWT missing sub claim")
        return user_id

    @router.get("/models")
    async def get_models(request: Request):
        """Return available models with plan-based access info."""
        user_id = await resolve_user(request)
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        allowed = set(settings.plan_allowed_models.get(machine.plan, []))
        models = [
            {
                "id": m["id"],
                "name": m["name"],
                "allowed": m["id"] in allowed,
            }
            for m in SWITCHABLE_MODELS
        ]

        return {
            "models": models,
            "current": machine.preferred_model,
        }

    @router.post("/models")
    async def set_model(request: Request, body: SetModelRequest):
        """Switch the user's agent model."""
        user_id = await resolve_user(request)

        if body.model not in SWITCHABLE_MODEL_IDS:
            raise HTTPException(status_code=400, detail="Unknown model")

        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")

        allowed = set(settings.plan_allowed_models.get(machine.plan, []))
        if body.model not in allowed:
            raise HTTPException(
                status_code=403, detail="Model not available on your plan"
            )

        # No-op if same model
        if machine.preferred_model == body.model:
            return {"status": "unchanged", "model": body.model}

        # Update DB — the LLM proxy reads preferred_model on every request,
        # so the switch takes effect immediately with no machine restart.
        await supabase.update_user_machine(
            machine.id, preferred_model=body.model
        )

        logger.info(f"[model_selection] User {user_id} switched to {body.model}")
        return {"status": "updated", "model": body.model}

    # ── Admin endpoints ───────────────────────────────────────────

    @router.get("/admin/default-model")
    async def get_default_model(request: Request):
        """Get the admin-configured default model for new machines."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:], api_key):
            raise HTTPException(status_code=401, detail="Unauthorized")

        value = await supabase.get_app_setting("default_model")
        return {"default_model": value or "anthropic/claude-opus-4-6"}

    @router.post("/admin/default-model")
    async def set_default_model(request: Request, body: AdminDefaultModelRequest):
        """Set the default model for newly provisioned machines."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:], api_key):
            raise HTTPException(status_code=401, detail="Unauthorized")

        if body.model not in SWITCHABLE_MODEL_IDS:
            raise HTTPException(status_code=400, detail="Unknown model")

        await supabase.set_app_setting(
            "default_model", body.model, "Default model for new machines"
        )
        logger.info(f"[model_selection] Admin set default model to {body.model}")
        return {"status": "updated", "default_model": body.model}

    return router
