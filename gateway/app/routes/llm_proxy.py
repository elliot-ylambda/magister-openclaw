"""LLM proxy routes for OpenClaw machines.

Two endpoints:
- POST /v1/messages        — Anthropic Messages API (native, used by OpenClaw agent)
- POST /v1/chat/completions — OpenAI-compatible (used by external integrations)
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse
from starlette.responses import Response, StreamingResponse

from app.middleware.auth import verify_machine_token
from app.models import LLMCompletionRequest
from app.services.llm import LLMService
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.llm_proxy")

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
# Headers to forward from OpenClaw to Anthropic
_FORWARD_HEADERS = {"anthropic-version", "anthropic-beta"}


def create_llm_proxy_router(
    llm: LLMService,
    supabase: SupabaseService,
) -> APIRouter:
    router = APIRouter()

    # ── Anthropic Messages API proxy (native format) ─────────

    @router.post("/v1/messages")
    async def anthropic_messages(
        request: Request,
        token_hash: str = Depends(verify_machine_token),
    ):
        """Transparent proxy: forwards Anthropic Messages API requests,
        replacing the gateway token with our real Anthropic API key."""
        machine = await supabase.get_user_machine_by_token_hash(token_hash)
        if not machine:
            raise HTTPException(status_code=401, detail="Unknown machine token")

        user_id = machine.user_id

        if not await llm.check_budget(user_id, machine.plan):
            raise HTTPException(status_code=402, detail="Monthly budget exceeded")

        body_bytes = await request.body()
        body = json.loads(body_bytes)
        model = body.get("model", "unknown")
        is_stream = body.get("stream", False)

        # Build headers for Anthropic (legacy path uses direct Anthropic key)
        fwd = {
            "x-api-key": llm._anthropic_key,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        for h in _FORWARD_HEADERS:
            val = request.headers.get(h)
            if val:
                fwd[h] = val

        if is_stream:
            return StreamingResponse(
                _proxy_anthropic_stream(fwd, body_bytes, user_id, model, llm),
                media_type="text/event-stream",
            )

        # Non-streaming: forward and return
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                ANTHROPIC_API_URL,
                content=body_bytes,
                headers=fwd,
                timeout=httpx.Timeout(300.0, connect=10.0),
            )

        # Record usage from successful responses
        if resp.status_code == 200:
            try:
                resp_json = resp.json()
                usage = resp_json.get("usage", {})
                inp = usage.get("input_tokens", 0)
                out = usage.get("output_tokens", 0)
                if inp or out:
                    cost = LLMService._calculate_cost(model, inp, out)
                    await llm._record_usage(user_id, model, inp, out, cost)
            except Exception:
                logger.warning("[llm_proxy] failed to record usage", exc_info=True)

        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )

    async def _proxy_anthropic_stream(
        headers: dict,
        body_bytes: bytes,
        user_id: str,
        model: str,
        llm_svc: LLMService,
    ) -> AsyncIterator[bytes]:
        """Forward Anthropic SSE stream, capturing usage from terminal events."""
        input_tokens = 0
        output_tokens = 0

        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                ANTHROPIC_API_URL,
                content=body_bytes,
                headers=headers,
                timeout=httpx.Timeout(300.0, connect=10.0),
            ) as resp:
                if resp.status_code != 200:
                    yield await resp.aread()
                    return

                async for line in resp.aiter_lines():
                    yield f"{line}\n".encode()

                    # Parse SSE data lines for usage tracking
                    if line.startswith("data: "):
                        try:
                            data = json.loads(line[6:])
                            evt = data.get("type")
                            if evt == "message_start":
                                u = data.get("message", {}).get("usage", {})
                                input_tokens = u.get("input_tokens", 0)
                            elif evt == "message_delta":
                                u = data.get("usage", {})
                                output_tokens = u.get("output_tokens", 0)
                        except (json.JSONDecodeError, KeyError):
                            pass

        # Record usage after stream completes
        if input_tokens or output_tokens:
            try:
                cost = LLMService._calculate_cost(model, input_tokens, output_tokens)
                await llm_svc._record_usage(
                    user_id, model, input_tokens, output_tokens, cost
                )
            except Exception:
                logger.warning("[llm_proxy] failed to record stream usage", exc_info=True)

    # ── OpenAI Chat Completions proxy (litellm) ──────────────

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
