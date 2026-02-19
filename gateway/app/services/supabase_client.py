"""Async wrapper around the Supabase Python client using the service-role key.

All database access in the gateway goes through this class.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from supabase import acreate_client, AsyncClient

from app.models import UserMachine, UsageEvent


class SupabaseService:
    """Async Supabase client wrapper for gateway DB operations."""

    def __init__(self, client: AsyncClient) -> None:
        self._client = client

    @classmethod
    async def create(cls, url: str, service_role_key: str) -> SupabaseService:
        """Factory: create an async Supabase client and wrap it."""
        client = await acreate_client(url, service_role_key)
        return cls(client)

    # ── User Machine Queries ─────────────────────────────────────

    async def get_user_machine(self, user_id: str) -> UserMachine | None:
        """Lookup by user_id, excluding destroyed machines."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("user_id", user_id)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        if result.data is None:
            return None
        return UserMachine(**result.data)

    async def get_user_machine_by_token_hash(
        self, token_hash: str
    ) -> UserMachine | None:
        """Lookup by SHA-256 gateway token hash (for LLM proxy auth)."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("gateway_token_hash", token_hash)
            .maybe_single()
            .execute()
        )
        if result.data is None:
            return None
        return UserMachine(**result.data)

    async def create_user_machine(self, data: dict) -> UserMachine:
        """Insert a new user_machine row."""
        result = (
            await self._client.table("user_machines")
            .insert(data)
            .execute()
        )
        return UserMachine(**result.data[0])

    async def update_user_machine(self, machine_id: str, **updates) -> None:
        """Partial update of a user_machine by its primary key."""
        await (
            self._client.table("user_machines")
            .update(updates)
            .eq("id", machine_id)
            .execute()
        )

    async def update_last_activity(self, user_id: str) -> None:
        """Set last_activity = now() for the user's running machine."""
        await (
            self._client.table("user_machines")
            .update({"last_activity": datetime.now(timezone.utc).isoformat()})
            .eq("user_id", user_id)
            .eq("status", "running")
            .execute()
        )

    # ── RPC Wrappers ─────────────────────────────────────────────

    async def claim_idle_machines(
        self, threshold: str, batch_size: int = 10
    ) -> list[UserMachine]:
        """Call the claim_idle_machines DB function."""
        result = await self._client.rpc(
            "claim_idle_machines",
            {"idle_threshold": threshold, "batch_size": batch_size},
        ).execute()
        return [UserMachine(**row) for row in (result.data or [])]

    async def get_monthly_llm_spend(self, user_id: str) -> int:
        """Call the get_monthly_llm_spend DB function. Returns cents."""
        result = await self._client.rpc(
            "get_monthly_llm_spend",
            {"p_user_id": user_id},
        ).execute()
        return result.data or 0

    # ── Reconciliation Queries ───────────────────────────────────

    async def get_failed_machines(self, cooldown_minutes: int = 5) -> list[UserMachine]:
        """Get machines that failed provisioning and have been in failed state
        for longer than cooldown_minutes (prevents re-cleaning immediately)."""
        cutoff = (
            datetime.now(timezone.utc) - timedelta(minutes=cooldown_minutes)
        ).isoformat()
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("status", "failed")
            .lt("updated_at", cutoff)
            .execute()
        )
        return [UserMachine(**row) for row in (result.data or [])]

    # ── Usage Tracking ───────────────────────────────────────────

    async def insert_usage_event(self, event: UsageEvent) -> None:
        """Insert a usage event row."""
        await (
            self._client.table("usage_events")
            .insert(event.model_dump(exclude_none=True))
            .execute()
        )
