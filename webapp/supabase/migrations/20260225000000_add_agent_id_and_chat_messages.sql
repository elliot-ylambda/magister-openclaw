-- Add agent_id to chat_sessions for multi-agent routing
ALTER TABLE public.chat_sessions
    ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'marketing';

-- Chat message history (persisted from webapp, replaces on-agent-only storage)
CREATE TABLE public.chat_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id  UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_role CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX idx_chat_messages_session
    ON public.chat_messages (session_id, created_at ASC);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own messages" ON public.chat_messages
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users insert own messages" ON public.chat_messages
    FOR INSERT WITH CHECK (auth.uid() = user_id);
