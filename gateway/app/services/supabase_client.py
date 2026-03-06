"""Async wrapper around the Supabase Python client using the service-role key.

All database access in the gateway goes through this class.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from supabase import acreate_client, AsyncClient

from app.models import SlackConnection, UserApiKey, UserMachine, UsageEvent


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
        if result is None or result.data is None:
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
        if result is None or result.data is None:
            return None
        return UserMachine(**result.data)

    async def get_user_machine_for_provision(self, user_id: str) -> UserMachine | None:
        """Lookup by user_id — includes ALL statuses (even destroyed).

        Used only by provision to see the full machine lifecycle so it can
        handle ghost records that still hold the fly_app_name unique constraint.
        """
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return UserMachine(**result.data)

    async def delete_user_machine(self, machine_id: str) -> None:
        """Physically delete a machine record (used to clear destroyed records)."""
        await (
            self._client.table("user_machines")
            .delete()
            .eq("id", machine_id)
            .execute()
        )

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

    async def get_running_machines(self) -> list[UserMachine]:
        """Get all machines with status='running' that have a fly_machine_id."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("status", "running")
            .filter("fly_machine_id", "not.is", "null")
            .execute()
        )
        return [UserMachine(**row) for row in (result.data or [])]

    # ── Slack Connections ──────────────────────────────────────────

    async def get_slack_connection_by_team(
        self, team_id: str
    ) -> SlackConnection | None:
        """Lookup active Slack connection by team_id (for webhook routing)."""
        result = (
            await self._client.table("slack_connections")
            .select("*")
            .eq("team_id", team_id)
            .eq("status", "active")
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return SlackConnection(**result.data)

    async def get_slack_connection(self, user_id: str) -> SlackConnection | None:
        """Lookup active Slack connection by user_id (for settings page)."""
        result = (
            await self._client.table("slack_connections")
            .select("*")
            .eq("user_id", user_id)
            .eq("status", "active")
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return SlackConnection(**result.data)

    async def upsert_slack_connection(self, data: dict) -> SlackConnection:
        """Upsert a Slack connection row (on user_id + team_id conflict)."""
        result = (
            await self._client.table("slack_connections")
            .upsert(data, on_conflict="user_id,team_id")
            .execute()
        )
        return SlackConnection(**result.data[0])

    async def revoke_slack_connection(
        self, user_id: str, team_id: str
    ) -> None:
        """Mark a Slack connection as revoked."""
        await (
            self._client.table("slack_connections")
            .update({"status": "revoked"})
            .eq("user_id", user_id)
            .eq("team_id", team_id)
            .execute()
        )

    async def get_all_slack_connections_for_team(
        self, team_id: str
    ) -> list[SlackConnection]:
        """Get all Slack connections for a team (any status) — used for app_uninstalled cleanup."""
        result = (
            await self._client.table("slack_connections")
            .select("*")
            .eq("team_id", team_id)
            .execute()
        )
        return [SlackConnection(**row) for row in (result.data or [])]

    async def revoke_all_slack_connections_for_team(self, team_id: str) -> None:
        """Mark all Slack connections for a team as revoked."""
        await (
            self._client.table("slack_connections")
            .update({"status": "revoked"})
            .eq("team_id", team_id)
            .execute()
        )

    # ── Global Secrets ─────────────────────────────────────────────

    RESERVED_SECRET_PREFIXES = ("GATEWAY_", "SLACK_")

    async def get_all_global_secrets(self) -> list[dict]:
        """Return all global secrets."""
        result = (
            await self._client.table("global_secrets")
            .select("*")
            .order("key")
            .execute()
        )
        return result.data or []

    async def get_user_secret_overrides(self, user_id: str) -> list[dict]:
        """Return all secret overrides for a specific user."""
        result = (
            await self._client.table("user_secret_overrides")
            .select("*")
            .eq("user_id", user_id)
            .execute()
        )
        return result.data or []

    async def get_merged_secrets_for_user(self, user_id: str) -> dict[str, str]:
        """Return global secrets merged with user overrides (overrides win).

        Filters out keys with reserved prefixes to avoid clobbering
        system secrets (GATEWAY_TOKEN, SLACK_BOT_TOKEN, etc.).
        """
        globals_ = await self.get_all_global_secrets()
        overrides = await self.get_user_secret_overrides(user_id)

        merged: dict[str, str] = {}
        for secret in globals_:
            key = secret["key"]
            if not any(key.startswith(p) for p in self.RESERVED_SECRET_PREFIXES):
                merged[key] = secret["value"]

        for override in overrides:
            key = override["secret_key"]
            if not any(key.startswith(p) for p in self.RESERVED_SECRET_PREFIXES):
                merged[key] = override["value"]

        return merged

    async def get_active_machines(self) -> list[UserMachine]:
        """Get machines with status running or suspended that have a fly_machine_id."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .in_("status", ["running", "suspended"])
            .filter("fly_machine_id", "not.is", "null")
            .execute()
        )
        return [UserMachine(**row) for row in (result.data or [])]

    # ── BYOK API Keys ─────────────────────────────────────────────

    async def get_user_api_keys(self, user_id: str) -> list[UserApiKey]:
        """Get all active BYOK API keys for a user."""
        result = (
            await self._client.table("user_api_keys")
            .select("*")
            .eq("user_id", user_id)
            .eq("status", "active")
            .execute()
        )
        return [UserApiKey(**row) for row in (result.data or [])]

    async def upsert_user_api_key(self, data: dict) -> UserApiKey:
        """Upsert a BYOK API key (on user_id + provider conflict)."""
        result = (
            await self._client.table("user_api_keys")
            .upsert(data, on_conflict="user_id,provider")
            .execute()
        )
        return UserApiKey(**result.data[0])

    async def revoke_user_api_key(self, user_id: str, provider: str) -> None:
        """Mark a BYOK API key as revoked."""
        await (
            self._client.table("user_api_keys")
            .update({"status": "revoked"})
            .eq("user_id", user_id)
            .eq("provider", provider)
            .execute()
        )

    # ── App Settings ──────────────────────────────────────────────

    async def get_app_setting(self, key: str) -> str | None:
        """Read a single value from app_settings."""
        result = (
            await self._client.table("app_settings")
            .select("value")
            .eq("key", key)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data["value"]

    async def set_app_setting(self, key: str, value: str, description: str = "") -> None:
        """Upsert a value into app_settings."""
        await (
            self._client.table("app_settings")
            .upsert({"key": key, "value": value, "description": description})
            .execute()
        )

    # ── Profiles ──────────────────────────────────────────────────

    async def get_user_profile(self, user_id: str) -> dict | None:
        """Lookup a user's profile by user_id."""
        result = (
            await self._client.table("profiles")
            .select("*")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    # ── Agent Emails ─────────────────────────────────────────────

    async def get_machine_by_email(self, email_address: str) -> dict | None:
        """Look up a user machine by its assigned email address."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("email_address", email_address)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def create_agent_email(self, data: dict) -> dict:
        """Insert a new email record."""
        result = (
            await self._client.table("agent_emails")
            .insert(data)
            .execute()
        )
        return result.data[0]

    async def update_agent_email(self, email_id: str, **updates) -> dict:
        """Update an email record."""
        result = (
            await self._client.table("agent_emails")
            .update(updates)
            .eq("id", email_id)
            .execute()
        )
        return result.data[0]

    async def get_agent_email(self, email_id: str) -> dict | None:
        """Get a single email by ID."""
        result = (
            await self._client.table("agent_emails")
            .select("*")
            .eq("id", email_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_agent_email_by_message_id(self, message_id: str) -> dict | None:
        """Look up an email by its Message-ID header (for threading)."""
        result = (
            await self._client.table("agent_emails")
            .select("*")
            .eq("message_id", message_id)
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_machine_by_token_hash(self, token_hash: str) -> dict | None:
        """Look up machine by gateway token hash."""
        result = (
            await self._client.table("user_machines")
            .select("*")
            .eq("gateway_token_hash", token_hash)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        if result is None or result.data is None:
            return None
        return result.data

    async def get_agent_emails(
        self, user_id: str, direction: str | None = None,
        status: str | None = None, since: str | None = None, limit: int = 50,
    ) -> list[dict]:
        """List emails for a user, optionally filtered."""
        query = self._client.table("agent_emails").select("*").eq("user_id", user_id)
        if direction:
            query = query.eq("direction", direction)
        if status:
            query = query.eq("status", status)
        if since:
            query = query.gte("created_at", since)
        result = await query.order("created_at", desc=True).limit(limit).execute()
        return result.data or []

    async def get_pending_outbound_emails(self, user_id: str) -> list[dict]:
        """Get emails awaiting user approval."""
        return await self.get_agent_emails(user_id, direction="outbound", status="pending")

    async def get_actionable_outbound_emails(self, user_id: str) -> list[dict]:
        """Get emails the agent needs to act on: pending + rewrite_requested."""
        result = (
            await self._client.table("agent_emails")
            .select("*")
            .eq("user_id", user_id)
            .eq("direction", "outbound")
            .in_("status", ["pending", "rewrite_requested"])
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        return result.data or []

    # ── Browser Control ─────────────────────────────────────

    async def create_browser_token(self, user_id: str, token: str, expires_at) -> dict:
        """Insert a browser connection token."""
        result = await (
            self._client.table("browser_connection_tokens")
            .insert({
                "user_id": user_id,
                "token": token,
                "expires_at": expires_at.isoformat(),
            })
            .execute()
        )
        return result.data[0]

    async def get_browser_token(self, token: str) -> dict | None:
        """Lookup a valid (unused, non-expired) browser connection token."""
        result = await (
            self._client.table("browser_connection_tokens")
            .select("*")
            .eq("token", token)
            .eq("used", False)
            .gt("expires_at", datetime.now(timezone.utc).isoformat())
            .maybe_single()
            .execute()
        )
        return result.data if result and result.data else None

    async def mark_browser_token_used(self, token_id: str) -> None:
        """Mark a browser connection token as used."""
        await (
            self._client.table("browser_connection_tokens")
            .update({"used": True})
            .eq("id", token_id)
            .execute()
        )

    async def get_browser_policy(self, user_id: str) -> dict | None:
        """Get browser control policy fields for a user's machine."""
        result = await (
            self._client.table("user_machines")
            .select("browser_enabled, browser_allowed_urls, browser_read_only")
            .eq("user_id", user_id)
            .neq("status", "destroyed")
            .maybe_single()
            .execute()
        )
        return result.data if result and result.data else None

    async def update_browser_policy(self, user_id: str, **fields) -> None:
        """Update browser control policy fields on a user's machine."""
        await (
            self._client.table("user_machines")
            .update(fields)
            .eq("user_id", user_id)
            .neq("status", "destroyed")
            .execute()
        )

    # ── Usage Tracking ───────────────────────────────────────────

    async def insert_usage_event(self, event: UsageEvent) -> None:
        """Insert a usage event row."""
        await (
            self._client.table("usage_events")
            .insert(event.model_dump(exclude_none=True))
            .execute()
        )
