-- Security Hardening Migration
-- Fixes three issues identified during security review:
--   1. bot_token exposed via RLS SELECT policy on slack_connections
--   2. handle_new_user() SECURITY DEFINER without SET search_path
--   3. stripe_customer_id unguarded in profiles UPDATE policy

-- =============================================================================
-- Fix 1: Create slack_connections_safe view (excludes bot_token)
-- Follows the user_machines_safe pattern from 20260218000000_create_user_machines.sql
-- =============================================================================

CREATE VIEW public.slack_connections_safe AS
SELECT id, user_id, team_id, team_name, bot_user_id, app_id,
       scope, status, created_at, updated_at
FROM public.slack_connections;

-- =============================================================================
-- Fix 2: Add SET search_path to handle_new_user()
-- Prevents search-path hijacking on this SECURITY DEFINER function.
-- CREATE OR REPLACE preserves the existing trigger binding.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;

-- =============================================================================
-- Fix 3: Guard stripe_customer_id in profiles UPDATE policy
-- Adds an immutability check so users cannot overwrite stripe_customer_id
-- via PostgREST. Service-role writes bypass RLS and are unaffected.
-- IS NOT DISTINCT FROM handles NULLs correctly (NULL = NULL → true).
-- =============================================================================

DROP POLICY "Users update own profile" ON public.profiles;

CREATE POLICY "Users update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (
        auth.uid() = id
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
        AND stripe_customer_id IS NOT DISTINCT FROM
            (SELECT p.stripe_customer_id FROM public.profiles p WHERE p.id = auth.uid())
    );
