-- Seed: create profile for dev user
-- The dev user (from migration 20260218000001) was inserted BEFORE the
-- on_auth_user_created trigger exists, so the trigger didn't fire.
-- This migration backfills the profile row.

INSERT INTO public.profiles (id, email, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev@magister.local', 'admin')
ON CONFLICT (id) DO NOTHING;
