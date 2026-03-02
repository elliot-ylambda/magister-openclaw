-- Migration: Create profiles, subscriptions, and chat_sessions tables
-- Part of Phase 1: Auth Foundation

-- =============================================================================
-- profiles: user profile data (auto-created on signup via trigger)
-- =============================================================================
CREATE TABLE public.profiles (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    display_name        TEXT,
    avatar_url          TEXT,
    role                TEXT NOT NULL DEFAULT 'user',
    stripe_customer_id  TEXT UNIQUE,
    onboarded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_role CHECK (role IN ('user', 'admin'))
);

-- =============================================================================
-- subscriptions: Stripe subscription tracking
-- =============================================================================
CREATE TABLE public.subscriptions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_subscription_id  TEXT NOT NULL UNIQUE,
    stripe_price_id         TEXT NOT NULL,
    plan                    TEXT NOT NULL DEFAULT 'cmo',
    status                  TEXT NOT NULL DEFAULT 'active',
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    cancel_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_plan CHECK (plan IN ('cmo', 'cmo_plus')),
    CONSTRAINT valid_sub_status CHECK (status IN (
        'active', 'canceled', 'incomplete', 'incomplete_expired',
        'past_due', 'trialing', 'unpaid', 'paused'
    ))
);

-- =============================================================================
-- chat_sessions: chat session metadata (for sidebar display)
-- =============================================================================
CREATE TABLE public.chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New conversation',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- Indexes
-- =============================================================================
CREATE INDEX idx_profiles_stripe ON public.profiles (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_subscriptions_user ON public.subscriptions (user_id);
CREATE INDEX idx_subscriptions_stripe ON public.subscriptions (stripe_subscription_id);
CREATE INDEX idx_chat_sessions_user ON public.chat_sessions (user_id, updated_at DESC);

-- =============================================================================
-- Trigger: auto-create profile on signup
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- Triggers: auto-update updated_at
-- Reuses handle_updated_at() from migration 20260216000001
-- =============================================================================
CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER chat_sessions_updated_at
    BEFORE UPDATE ON public.chat_sessions
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- =============================================================================
-- Row Level Security
-- =============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

-- Profiles: users read own
CREATE POLICY "Users read own profile" ON public.profiles
    FOR SELECT USING (auth.uid() = id);

-- Profiles: users update own, but cannot change their role
CREATE POLICY "Users update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (
        auth.uid() = id
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
    );

-- Subscriptions: users read own
CREATE POLICY "Users read own subscriptions" ON public.subscriptions
    FOR SELECT USING (auth.uid() = user_id);

-- Chat sessions: users full CRUD on own
CREATE POLICY "Users read own sessions" ON public.chat_sessions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users create own sessions" ON public.chat_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own sessions" ON public.chat_sessions
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users delete own sessions" ON public.chat_sessions
    FOR DELETE USING (auth.uid() = user_id);
