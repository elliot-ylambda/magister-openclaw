-- Browser control columns on user_machines
ALTER TABLE public.user_machines
  ADD COLUMN browser_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN browser_allowed_urls TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN browser_read_only BOOLEAN NOT NULL DEFAULT false;

-- Recreate safe view to include browser control fields
DROP VIEW IF EXISTS public.user_machines_safe;
CREATE VIEW public.user_machines_safe AS
SELECT id, user_id, fly_app_name, fly_region, status, last_activity,
       plan, max_agents, preferred_model, pending_image, current_image,
       provisioning_step, browser_enabled, browser_allowed_urls, browser_read_only,
       created_at, updated_at
FROM public.user_machines;

-- Connection tokens for extension auth flow
CREATE TABLE public.browser_connection_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.browser_connection_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own tokens"
  ON public.browser_connection_tokens FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX idx_browser_connection_tokens_token
  ON public.browser_connection_tokens(token);
