-- Chat session metadata (for sidebar display)
-- Actual message content lives on the OpenClaw volume; this table
-- only tracks session identity and title for the webapp sidebar.

CREATE TABLE public.chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New conversation',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_sessions_user ON public.chat_sessions (user_id, updated_at DESC);

-- Reuses handle_updated_at() from migration 20260216000001
CREATE TRIGGER chat_sessions_updated_at
    BEFORE UPDATE ON public.chat_sessions
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

-- Full CRUD RLS: users manage own sessions only
CREATE POLICY "Users read own sessions" ON public.chat_sessions
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users create own sessions" ON public.chat_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own sessions" ON public.chat_sessions
    FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own sessions" ON public.chat_sessions
    FOR DELETE USING (auth.uid() = user_id);
