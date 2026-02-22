"""POST /llm/v1/chat/completions — LLM proxy for OpenClaw machines."""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.middleware.auth import verify_machine_token
from app.models import LLMCompletionRequest
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.llm_proxy")


def create_llm_proxy_router(
    llm: LLMService,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    @router.post("/v1/chat/completions")
    async def chat_completions(
        req: LLMCompletionRequest,
        token_hash: str = Depends(verify_machine_token),
    ):
        # Lookup machine by token hash
        machine = await supabase.get_user_machine_by_token_hash(token_hash)
        if not machine:
            raise HTTPException(status_code=401, detail="Unknown machine token")

        user_id = machine.user_id
        plan = machine.plan

        # Model validation
        if not llm.validate_model(req.model, plan):
            raise HTTPException(
                status_code=403,
                detail=f"Model {req.model} not allowed on plan {plan}",
            )

        # Budget check
        if not await llm.check_budget(user_id, plan):
            raise HTTPException(status_code=402, detail="Monthly budget exceeded")

        # Build kwargs from extra fields (top_p, tools, tool_choice, etc.)
        kwargs = dict(req.model_extra or {})
        if req.temperature is not None:
            kwargs["temperature"] = req.temperature
        if req.max_tokens is not None:
            kwargs["max_tokens"] = req.max_tokens

        if req.stream:
            return EventSourceResponse(
                _stream_response(llm, req, user_id, kwargs)
            )

        # Non-streaming
        response = await llm.completion(
            model=req.model,
            messages=req.messages,
            user_id=user_id,
            stream=False,
            **kwargs,
        )
        return response.model_dump()

    async def _stream_response(
        llm: LLMService,
        req: LLMCompletionRequest,
        user_id: str,
        kwargs: dict,
    ) -> AsyncIterator[str]:
        """Yield SSE data lines from a streaming LLM response."""
        try:
            stream = await llm.completion(
                model=req.model,
                messages=req.messages,
                user_id=user_id,
                stream=True,
                **kwargs,
            )
            async for chunk in stream:
                yield json.dumps(chunk.model_dump())
            yield "[DONE]"
        except Exception:
            logger.exception(f"[llm_proxy] stream error for {user_id}")
            error_payload = {"error": {"message": "Internal server error"}}
            yield json.dumps(error_payload)

    return router
