-- Add model column to track which LLM generated each message
ALTER TABLE public.chat_messages
  ADD COLUMN model TEXT DEFAULT NULL;

-- Allow 'system' role for model-switch indicator messages
ALTER TABLE public.chat_messages
  DROP CONSTRAINT valid_role;

ALTER TABLE public.chat_messages
  ADD CONSTRAINT valid_role CHECK (role IN ('user', 'assistant', 'system'));
