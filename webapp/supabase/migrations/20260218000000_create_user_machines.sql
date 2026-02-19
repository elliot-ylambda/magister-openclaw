-- Migration: Create user_machines and usage_events tables
-- Part of multi-tenant agent infrastructure (Phase 1)

-- =============================================================================
-- user_machines: maps users to their Fly.io infrastructure
-- =============================================================================
CREATE TABLE public.user_machines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Fly.io infrastructure
    fly_app_name        TEXT NOT NULL UNIQUE,
    fly_machine_id      TEXT,
    fly_volume_id       TEXT,
    fly_region          TEXT NOT NULL DEFAULT 'iad',

    -- Lifecycle state
    -- provisioning -> running -> suspending -> suspended -> running -> ...
    -- provisioning -> failed
    -- any -> destroying -> destroyed
    -- 'suspending' is a transient state used by the idle sweep's
    -- FOR UPDATE SKIP LOCKED to claim machines atomically
    status              TEXT NOT NULL DEFAULT 'provisioning',

    last_activity       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Plan & limits
    plan                TEXT NOT NULL DEFAULT 'cmo',
    max_agents          INT NOT NULL DEFAULT 1,

    -- Internal auth (per-machine bearer token)
    -- gateway_token: plaintext, used by Gateway for chat forwarding (Gateway->Machine)
    -- gateway_token_hash: SHA-256 hash, used for LLM proxy auth lookup (Machine->Gateway)
    -- Both columns are service-role-only (not exposed via frontend view)
    gateway_token       TEXT,
    gateway_token_hash  TEXT,

    -- Deploy tracking
    pending_image       TEXT,
    current_image       TEXT,

    -- Provisioning state machine (idempotent retry from last successful step)
    provisioning_step   INT DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_status CHECK (status IN (
        'provisioning', 'running', 'suspending', 'suspended',
        'failed', 'destroying', 'destroyed'
    ))
);

-- =============================================================================
-- usage_events: tracks LLM token usage for budget enforcement
-- =============================================================================
CREATE TABLE public.usage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- No CASCADE: preserves billing history even if user is deleted
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    event_type      TEXT NOT NULL,
    -- 'llm_request'     — tokens consumed (primary for budget enforcement)
    -- 'machine_minute'  — compute time
    -- 'tool_execution'  — web search, browser, shell

    model           TEXT,
    input_tokens    INT,
    output_tokens   INT,
    cost_cents      INT,          -- ceil-rounded to avoid recording $0

    duration_ms     INT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Idle machine lookup (used by sweep every 2 minutes)
CREATE INDEX idx_user_machines_idle
    ON public.user_machines (last_activity)
    WHERE status = 'running';

-- User lookup (used on every chat/status request)
CREATE INDEX idx_user_machines_user
    ON public.user_machines (user_id);

-- Token hash lookup (used on every LLM proxy request for machine auth)
CREATE INDEX idx_user_machines_token_hash
    ON public.user_machines (gateway_token_hash)
    WHERE gateway_token_hash IS NOT NULL;

-- Monthly spend (queried on every LLM request with 30s cache)
CREATE INDEX idx_usage_events_monthly_spend
    ON public.usage_events (user_id, created_at)
    WHERE event_type = 'llm_request';

-- Billing/analytics queries
CREATE INDEX idx_usage_events_billing
    ON public.usage_events (user_id, created_at);

-- =============================================================================
-- Trigger: auto-update updated_at
-- Reuses handle_updated_at() from migration 20260216000001
-- =============================================================================
CREATE TRIGGER user_machines_updated_at
    BEFORE UPDATE ON public.user_machines
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- =============================================================================
-- Functions
-- =============================================================================

-- Claim idle machines for suspension using FOR UPDATE SKIP LOCKED.
-- Replaces advisory locks (which don't work via Supabase RPC because
-- each RPC is its own transaction, releasing the lock immediately).
-- Multiple Gateway instances can safely call this concurrently — each
-- claims a different batch of idle machines.
CREATE OR REPLACE FUNCTION public.claim_idle_machines(
    idle_threshold TIMESTAMPTZ,
    batch_size INT DEFAULT 10
)
RETURNS SETOF public.user_machines AS $$
BEGIN
    RETURN QUERY
    UPDATE public.user_machines
    SET status = 'suspending'
    WHERE id IN (
        SELECT id FROM public.user_machines
        WHERE status = 'running'
          AND last_activity < idle_threshold
        ORDER BY last_activity ASC
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Helper: get current month's LLM spend for a user (used by budget checks)
CREATE OR REPLACE FUNCTION public.get_monthly_llm_spend(p_user_id UUID)
RETURNS INT AS $$
BEGIN
    RETURN COALESCE(
        (SELECT SUM(cost_cents) FROM public.usage_events
         WHERE user_id = p_user_id
           AND event_type = 'llm_request'
           AND created_at >= date_trunc('month', now())),
        0
    );
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- Security: Revoke RPC access from non-service-role callers
-- Without this, any authenticated user could call claim_idle_machines()
-- via PostgREST to suspend other users' machines, or get_monthly_llm_spend()
-- with arbitrary user IDs.
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.claim_idle_machines FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.get_monthly_llm_spend FROM PUBLIC, authenticated, anon;

-- =============================================================================
-- Row Level Security
-- Users can read own rows only. All writes via service_role.
-- =============================================================================
ALTER TABLE public.user_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own machines" ON public.user_machines
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users read own usage" ON public.usage_events
    FOR SELECT USING (auth.uid() = user_id);

-- =============================================================================
-- Safe view: excludes token columns for frontend queries
-- The RLS SELECT policy grants row access, but exposes gateway_token and
-- gateway_token_hash. This view provides a safe projection for the frontend.
-- =============================================================================
CREATE VIEW public.user_machines_safe AS
SELECT id, user_id, fly_app_name, fly_region, status, last_activity,
       plan, max_agents, pending_image, current_image,
       provisioning_step, created_at, updated_at
FROM public.user_machines;
