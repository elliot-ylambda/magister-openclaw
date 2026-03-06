ALTER TABLE agent_emails DROP CONSTRAINT IF EXISTS agent_emails_status_check;
ALTER TABLE agent_emails ADD CONSTRAINT agent_emails_status_check
  CHECK (status IN ('pending', 'approved', 'sent', 'rejected', 'received', 'quarantined', 'failed', 'rewrite_requested'));
ALTER TABLE agent_emails ADD COLUMN IF NOT EXISTS rewrite_note TEXT;
