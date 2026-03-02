-- Add attachments JSONB column to chat_messages
ALTER TABLE public.chat_messages
  ADD COLUMN attachments JSONB DEFAULT NULL;

-- Create private storage bucket for chat attachments
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: users can upload to their own path prefix ({user_id}/*)
CREATE POLICY "Users upload own attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: users can read their own attachments
CREATE POLICY "Users read own attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
