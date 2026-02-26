-- Slack workspace connections (one row per user-workspace pair)
CREATE TABLE public.slack_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    team_id         TEXT NOT NULL,
    team_name       TEXT NOT NULL DEFAULT '',
    bot_user_id     TEXT NOT NULL DEFAULT '',
    app_id          TEXT NOT NULL DEFAULT '',
    bot_token       TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_user_team UNIQUE (user_id, team_id),
    CONSTRAINT valid_status CHECK (status IN ('active', 'revoked', 'error'))
);

-- Fast lookup by team_id for webhook routing (only active connections)
CREATE INDEX idx_slack_connections_team ON public.slack_connections (team_id) WHERE status = 'active';

-- Fast lookup by user_id for settings page
CREATE INDEX idx_slack_connections_user ON public.slack_connections (user_id);

-- RLS: users can read their own connections; writes happen via service_role
ALTER TABLE public.slack_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own slack connections"
    ON public.slack_connections
    FOR SELECT
    USING (auth.uid() = user_id);
