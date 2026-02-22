-- Seed: local dev user_machine for Docker-based development
-- Deterministic token matches DEV_MACHINE_TOKEN in .env.docker.example
-- Idempotent: safe to run multiple times

-- Create a dev user in auth.users (required by FK constraint)
INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    confirmation_token,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'dev@magister.local',
    crypt('dev-password-not-for-production', gen_salt('bf')),
    now(),
    now(),
    now(),
    '',
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"name": "Dev User"}'::jsonb,
    false
)
ON CONFLICT (id) DO NOTHING;

-- Insert dev machine row
-- gateway_token_hash = SHA-256 of 'dev-local-token-magister-2026'
INSERT INTO public.user_machines (
    id,
    user_id,
    fly_app_name,
    fly_machine_id,
    fly_region,
    status,
    plan,
    gateway_token,
    gateway_token_hash
)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'magister-dev-local',
    'dev-machine-local',
    'local',
    'running',
    'cmo',
    'dev-local-token-magister-2026',
    encode(sha256('dev-local-token-magister-2026'::bytea), 'hex')
)
ON CONFLICT (id) DO NOTHING;
