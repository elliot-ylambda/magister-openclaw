-- Migration: Create agent email system tables
-- Tables: agent_emails (inbox/outbox), add email_address column to user_machines

-- Add email address to user_machines (assigned at provision time)
ALTER TABLE public.user_machines
ADD COLUMN IF NOT EXISTS email_address TEXT UNIQUE;

-- Agent emails table: stores all inbound and outbound emails
CREATE TABLE public.agent_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES public.user_machines(id) ON DELETE CASCADE,

    -- Direction and status
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'approved',
        'sent',
        'rejected',
        'received',
        'delivered',
        'quarantined',
        'failed'
    )),

    -- Email fields
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    cc TEXT[],
    bcc TEXT[],
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT,
    body_html TEXT,
    reply_to TEXT,

    -- Threading (RFC 2822)
    message_id TEXT UNIQUE,
    in_reply_to TEXT,
    references_header TEXT,
    thread_id UUID,

    -- Attachments stored as JSONB array
    attachments JSONB DEFAULT '[]'::jsonb,

    -- Metadata
    resend_email_id TEXT,
    scan_result JSONB,
    rejection_reason TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_agent_emails_user_id ON public.agent_emails(user_id);
CREATE INDEX idx_agent_emails_machine_id ON public.agent_emails(machine_id);
CREATE INDEX idx_agent_emails_status ON public.agent_emails(status);
CREATE INDEX idx_agent_emails_direction ON public.agent_emails(direction);
CREATE INDEX idx_agent_emails_thread_id ON public.agent_emails(thread_id);
CREATE INDEX idx_agent_emails_to_address ON public.agent_emails(to_address);
CREATE INDEX idx_agent_emails_message_id ON public.agent_emails(message_id);
CREATE INDEX idx_agent_emails_created_at ON public.agent_emails(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_agent_emails_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_emails_updated_at
    BEFORE UPDATE ON public.agent_emails
    FOR EACH ROW
    EXECUTE FUNCTION public.update_agent_emails_updated_at();

-- RLS
ALTER TABLE public.agent_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own emails"
    ON public.agent_emails FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to agent_emails"
    ON public.agent_emails FOR ALL
    USING (auth.role() = 'service_role');
