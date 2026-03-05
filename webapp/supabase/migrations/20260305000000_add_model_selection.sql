-- Add preferred_model to user_machines
ALTER TABLE public.user_machines
  ADD COLUMN preferred_model TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-4-6';

-- Recreate safe view to include preferred_model
DROP VIEW IF EXISTS public.user_machines_safe;
CREATE VIEW public.user_machines_safe AS
SELECT id, user_id, fly_app_name, fly_region, status, last_activity,
       plan, max_agents, preferred_model, pending_image, current_image,
       provisioning_step, created_at, updated_at
FROM public.user_machines;

-- App-level settings for admin config (not machine secrets)
CREATE TABLE public.app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Seed default model setting
INSERT INTO public.app_settings (key, value, description)
VALUES ('default_model', 'anthropic/claude-sonnet-4-6', 'Default model for new machines');
