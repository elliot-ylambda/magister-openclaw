"""Browser relay WebSocket proxy with CDP policy enforcement.

Proxies WebSocket frames between the Chrome extension and the agent machine's
relay server, inspecting CDP commands for policy violations (URL allowlist,
read-only mode).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from urllib.parse import urlparse

import jwt as pyjwt
import websockets
from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.browser_relay")

RELAY_PORT = 18792

# In-memory tracking of connected extensions: user_id -> True
_connections: dict[str, bool] = {}

# CDP methods blocked in read-only mode
READONLY_BLOCKED_PREFIXES = ("Input.", "DOM.set", "DOM.remove", "Emulation.")
READONLY_BLOCKED_METHODS = frozenset({
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Page.navigate",
    "Page.reload",
    "Target.createTarget",
    "Target.closeTarget",
    "DOM.setAttributeValue",
    "DOM.setAttributesAsText",
    "DOM.setNodeValue",
    "DOM.removeNode",
    "DOM.removeAttribute",
})

# CDP methods that carry a URL to check against the allowlist
URL_BEARING_METHODS = {"Page.navigate": "url", "Target.createTarget": "url"}


def derive_relay_token(gateway_token: str, port: int) -> str:
    """Derive the HMAC-SHA256 relay token matching background-utils.js."""
    message = f"openclaw-extension-relay-v1:{port}"
    return hmac.new(
        gateway_token.encode(), message.encode(), hashlib.sha256
    ).hexdigest()


def is_url_allowed(url: str, allowed_domains: list[str]) -> bool:
    """Check if a URL's domain matches the allowlist. Empty list = allow all."""
    if not allowed_domains:
        return True
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
    except Exception:
        return False
    if not hostname:
        return False
    for domain in allowed_domains:
        d = domain.lower().strip()
        if hostname == d or hostname.endswith(f".{d}"):
            return True
    return False


def _is_readonly_blocked(cdp_method: str) -> bool:
    """Check if a CDP method is blocked in read-only mode."""
    if cdp_method in READONLY_BLOCKED_METHODS:
        return True
    for prefix in READONLY_BLOCKED_PREFIXES:
        if cdp_method.startswith(prefix):
            return True
    return False


def check_policy(
    msg: dict, *, read_only: bool, allowed_urls: list[str]
) -> tuple[bool, str]:
    """Inspect a relay message for policy violations.

    Returns (allowed, reason). If allowed is True, reason is empty.
    Only inspects forwardCDPCommand frames — everything else passes through.
    """
    if msg.get("method") != "forwardCDPCommand":
        return True, ""

    params = msg.get("params", {})
    cdp_method = params.get("method", "")

    # Read-only check
    if read_only and _is_readonly_blocked(cdp_method):
        return False, f"Blocked by read-only mode: {cdp_method}"

    # URL allowlist check
    if cdp_method in URL_BEARING_METHODS and allowed_urls:
        url_key = URL_BEARING_METHODS[cdp_method]
        inner_params = params.get("params", {})
        target_url = inner_params.get(url_key, "")
        if target_url and not is_url_allowed(target_url, allowed_urls):
            return False, f"URL not in allowlist: {target_url}"

    return True, ""


def create_browser_relay_router(
    fly: FlyClient,
    supabase: SupabaseService,
    *,
    jwt_secret: str,
    api_key: str = "",
    supabase_url: str = "",
    dev_machine_url: str = "",
) -> APIRouter:
    router = APIRouter()

    # Set up JWKS client for ES256 verification
    jwks_client = None
    if supabase_url:
        from jwt import PyJWKClient
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)

    def _decode_jwt(token: str) -> str:
        """Decode a JWT and return the user_id (sub claim)."""
        try:
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg", "HS256")

            if alg == "ES256" and jwks_client:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = pyjwt.decode(
                    token, signing_key.key,
                    algorithms=["ES256"], audience="authenticated",
                )
            else:
                payload = pyjwt.decode(
                    token, jwt_secret,
                    algorithms=["HS256"], audience="authenticated",
                )
        except pyjwt.exceptions.PyJWTError as exc:
            raise ValueError(f"Invalid JWT: {exc}")

        user_id = payload.get("sub")
        if not user_id:
            raise ValueError("JWT missing sub claim")
        return user_id

    def _build_upstream_url(machine) -> str:
        """Build the WebSocket URL to the agent machine's relay server."""
        if dev_machine_url:
            # Local dev: replace http(s) with ws and point to relay port
            base = dev_machine_url.replace("https://", "ws://").replace("http://", "ws://")
            # Strip any existing port and path
            parsed = urlparse(base)
            host = parsed.hostname or "localhost"
            return f"ws://{host}:{RELAY_PORT}/extension"

        # Production: Fly internal DNS
        return (
            f"ws://{machine.fly_machine_id}.vm.{machine.fly_app_name}.internal"
            f":{RELAY_PORT}/extension"
        )

    @router.websocket("/browser/relay")
    async def browser_relay(ws: WebSocket, token: str = Query(...)):
        # Authenticate
        try:
            user_id = _decode_jwt(token)
        except ValueError as exc:
            await ws.close(code=4001, reason=str(exc))
            return

        # Look up machine
        machine = await supabase.get_user_machine(user_id)
        if not machine or not machine.browser_enabled:
            await ws.close(code=4003, reason="Browser control not enabled")
            return

        if not machine.fly_machine_id:
            await ws.close(code=4004, reason="No machine available")
            return

        # Wake machine if suspended
        if machine.status.value == "suspended" and machine.fly_machine_id:
            try:
                await fly.start_machine(machine.fly_app_name, machine.fly_machine_id)
                await fly.wait_for_state(
                    machine.fly_app_name, machine.fly_machine_id, "started", timeout_s=30
                )
            except Exception:
                logger.exception(f"[browser_relay] Failed to wake machine for {user_id}")
                await ws.close(code=4005, reason="Failed to wake agent machine")
                return

        # Build upstream URL with relay token
        upstream_url = _build_upstream_url(machine)
        relay_token = derive_relay_token(machine.gateway_token or "", RELAY_PORT)
        upstream_ws_url = f"{upstream_url}?token={relay_token}"

        # Accept the extension's WebSocket
        await ws.accept()

        # Load policy
        read_only = machine.browser_read_only
        allowed_urls = machine.browser_allowed_urls

        # Connect upstream to agent machine relay
        try:
            upstream = await websockets.connect(upstream_ws_url, open_timeout=10)
        except Exception:
            logger.exception(f"[browser_relay] Failed to connect upstream for {user_id}")
            await ws.close(code=4006, reason="Failed to connect to agent relay")
            return

        _connections[user_id] = True
        logger.info(f"[browser_relay] Connected for user {user_id}")

        async def ext_to_upstream():
            """Forward extension → upstream with policy enforcement.

            CDP commands originate from the extension, so policy checks
            (read-only mode, URL allowlist) are applied here before the
            command reaches the agent machine.
            """
            try:
                while True:
                    data = await ws.receive_text()
                    try:
                        msg = json.loads(data)
                    except (json.JSONDecodeError, TypeError):
                        await upstream.send(data)
                        continue

                    allowed, reason = check_policy(
                        msg, read_only=read_only, allowed_urls=allowed_urls
                    )
                    if not allowed:
                        # Send error response back to the extension
                        error_resp = {"id": msg.get("id"), "error": reason}
                        await ws.send_text(json.dumps(error_resp))
                        logger.info(f"[browser_relay] Policy blocked: {reason}")
                        continue

                    await upstream.send(data)
            except WebSocketDisconnect:
                pass
            except Exception:
                pass

        async def upstream_to_ext():
            """Forward upstream → extension (responses/events, no policy check needed)."""
            try:
                async for raw in upstream:
                    await ws.send_text(raw if isinstance(raw, str) else raw.decode())
            except websockets.exceptions.ConnectionClosed:
                pass
            except Exception:
                pass

        try:
            await asyncio.gather(ext_to_upstream(), upstream_to_ext())
        finally:
            _connections.pop(user_id, None)
            logger.info(f"[browser_relay] Disconnected for user {user_id}")
            try:
                await upstream.close()
            except Exception:
                pass

    @router.get("/browser/status")
    async def browser_status(request: Request, user_id: str = Query(...)):
        """Check if a user's extension is currently connected. Protected by API key."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != api_key:
            raise HTTPException(status_code=401, detail="Invalid API key")
        return {"connected": user_id in _connections}

    return router
