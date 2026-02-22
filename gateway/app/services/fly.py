"""Async HTTP client for the Fly Machines REST API + GraphQL API (for secrets)."""

from __future__ import annotations

import asyncio

import httpx


MACHINES_BASE_URL = "https://api.machines.dev/v1"
GRAPHQL_URL = "https://api.fly.io/graphql"

MAX_RETRIES = 3
BACKOFF_BASE = 0.5  # seconds


class FlyClient:
    """Async client for Fly.io machine management."""

    def __init__(self, api_token: str, org: str) -> None:
        self._token = api_token
        self._org = org
        self._http = httpx.AsyncClient(
            base_url=MACHINES_BASE_URL,
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=30.0,
        )

    # ── Internal helpers ─────────────────────────────────────────

    async def _request(
        self, method: str, path: str, *, json: dict | None = None
    ) -> dict:
        """HTTP request with retry logic for 5xx and timeouts."""
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                resp = await self._http.request(method, path, json=json)
                if resp.status_code >= 500:
                    last_exc = Exception(
                        f"Fly API {resp.status_code}: {resp.text}"
                    )
                    await asyncio.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                if resp.status_code >= 400:
                    raise Exception(
                        f"Fly API {resp.status_code}: {resp.text}"
                    )
                # 2xx / 3xx — success (may be empty body)
                if resp.status_code == 204 or not resp.content:
                    return {}
                return resp.json()
            except httpx.TimeoutException as exc:
                last_exc = exc
                await asyncio.sleep(BACKOFF_BASE * (2 ** attempt))
                continue
        raise last_exc  # type: ignore[misc]

    # ── App operations ───────────────────────────────────────────

    async def create_app(self, name: str) -> dict:
        return await self._request(
            "POST",
            "/apps",
            json={"app_name": name, "org_slug": self._org},
        )

    async def delete_app(self, name: str) -> dict:
        return await self._request("DELETE", f"/apps/{name}")

    # ── Secrets (GraphQL) ────────────────────────────────────────

    async def set_secrets(self, app_name: str, secrets: dict[str, str]) -> dict:
        """Set secrets on a Fly app via the GraphQL API."""
        mutation = """
        mutation($input: SetSecretsInput!) {
            setSecrets(input: $input) {
                app { name }
            }
        }
        """
        secrets_list = [{"key": k, "value": v} for k, v in secrets.items()]
        variables = {
            "input": {
                "appId": app_name,
                "secrets": secrets_list,
            }
        }
        async with httpx.AsyncClient(timeout=30.0) as gql_client:
            resp = await gql_client.post(
                GRAPHQL_URL,
                headers={"Authorization": f"Bearer {self._token}"},
                json={"query": mutation, "variables": variables},
            )
            resp.raise_for_status()
            return resp.json()

    # ── Volume operations ────────────────────────────────────────

    async def create_volume(
        self, app: str, name: str, size_gb: int, region: str
    ) -> dict:
        return await self._request(
            "POST",
            f"/apps/{app}/volumes",
            json={"name": name, "size_gb": size_gb, "region": region},
        )

    async def delete_volume(self, app: str, vol_id: str) -> dict:
        return await self._request("DELETE", f"/apps/{app}/volumes/{vol_id}")

    # ── Machine operations ───────────────────────────────────────

    async def create_machine(self, app: str, config: dict) -> dict:
        return await self._request(
            "POST", f"/apps/{app}/machines", json=config
        )

    async def get_machine(self, app: str, machine_id: str) -> dict:
        return await self._request(
            "GET", f"/apps/{app}/machines/{machine_id}"
        )

    async def start_machine(self, app: str, machine_id: str) -> dict:
        return await self._request(
            "POST", f"/apps/{app}/machines/{machine_id}/start"
        )

    async def stop_machine(self, app: str, machine_id: str) -> dict:
        return await self._request(
            "POST", f"/apps/{app}/machines/{machine_id}/stop"
        )

    async def suspend_machine(self, app: str, machine_id: str) -> dict:
        return await self._request(
            "POST", f"/apps/{app}/machines/{machine_id}/suspend"
        )

    async def delete_machine(self, app: str, machine_id: str) -> dict:
        return await self._request(
            "DELETE", f"/apps/{app}/machines/{machine_id}"
        )

    # ── Lifecycle helper ─────────────────────────────────────────

    async def wait_for_state(
        self,
        app: str,
        machine_id: str,
        target_state: str,
        timeout_s: int = 30,
    ) -> dict:
        """Poll get_machine every 1s until it reaches target_state."""
        elapsed = 0
        while elapsed < timeout_s:
            info = await self.get_machine(app, machine_id)
            if info.get("state") == target_state:
                return info
            await asyncio.sleep(1)
            elapsed += 1
        raise TimeoutError(
            f"Machine {machine_id} did not reach '{target_state}' "
            f"within {timeout_s}s"
        )

    # ── Cleanup ──────────────────────────────────────────────────

    async def close(self) -> None:
        await self._http.aclose()
