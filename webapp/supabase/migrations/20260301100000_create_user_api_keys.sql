-- BYOK (Bring Your Own Key) API keys (one key per provider per user)
CREATE TABLE public.user_api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    api_key         TEXT NOT NULL,
    key_suffix      TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_user_provider UNIQUE (user_id, provider),
    CONSTRAINT valid_provider CHECK (provider IN ('openrouter', 'anthropic', 'openai', 'gemini')),
    CONSTRAINT valid_status CHECK (status IN ('active', 'revoked'))
);

-- Fast lookup by user_id for active keys (used by gateway at LLM proxy time)
CREATE INDEX idx_user_api_keys_user_active ON public.user_api_keys (user_id) WHERE status = 'active';

-- Auto-update updated_at (reuse existing trigger function)
CREATE TRIGGER set_user_api_keys_updated_at
    BEFORE UPDATE ON public.user_api_keys
    FOR EACH ROW
    EXECUTE FUNCTION handle_updated_at();

-- RLS: users can read their own keys; writes happen via service_role
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own api keys"
    ON public.user_api_keys
    FOR SELECT
    USING (auth.uid() = user_id);

-- Safe view excluding the actual api_key column (for settings page)
CREATE VIEW public.user_api_keys_safe AS
SELECT id, user_id, provider, key_suffix, status, created_at, updated_at
FROM public.user_api_keys;
