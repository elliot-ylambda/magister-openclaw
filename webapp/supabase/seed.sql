-- =============================================================
-- Local development seed data
-- =============================================================
-- This file runs ONLY during `supabase db reset --local`.
-- It is NOT applied to production (supabase db push ignores seeds).
--
-- Creates:
--   1. A dev user in auth.users + auth.identities
--   2. A profile row (admin) in public.profiles
--   3. A dev machine row in public.user_machines
-- =============================================================

-- 1. Dev user in auth.users ──────────────────────────────────

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
    recovery_token,
    email_change,
    email_change_token_new,
    email_change_token_current,
    phone,
    phone_change,
    phone_change_token,
    reauthentication_token,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    is_sso_user,
    is_anonymous
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
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"name": "Dev User"}'::jsonb,
    false,
    false,
    false
)
ON CONFLICT (id) DO NOTHING;

-- 2. Identity row (required by GoTrue for password login) ────

INSERT INTO auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '{"sub": "00000000-0000-0000-0000-000000000001", "email": "dev@magister.local"}'::jsonb,
    'email',
    now(),
    now(),
    now()
)
ON CONFLICT (provider_id, provider) DO NOTHING;

-- 3. Dev profile (admin) ─────────────────────────────────────
-- Inserted explicitly because the on_auth_user_created trigger
-- doesn't fire for rows inserted directly into auth.users.

INSERT INTO public.profiles (id, email, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev@magister.local', 'admin')
ON CONFLICT (id) DO NOTHING;

-- 4. Dev machine row ─────────────────────────────────────────

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

-- 5. Allow dev user to sign up ─────────────────────────────────

INSERT INTO public.signup_allowlist (email, notes)
VALUES ('dev@magister.local', 'Local development user')
ON CONFLICT DO NOTHING;
