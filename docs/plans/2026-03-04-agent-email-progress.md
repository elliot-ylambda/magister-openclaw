# Agent Email System - Progress

## End Goal

Every AI agent gets a dedicated email address (`agent-{userId}@agent.magistermarketing.com`) so it can send and receive emails autonomously. Outbound emails always require user approval. Inbound emails are scanned for malicious content. All emails stored in Supabase for full audit trail. Resend handles SMTP infrastructure (MX inbound + API outbound).

## Approach

- **Resend** as email provider (already used in webapp for transactional email)
- **Gateway** as security boundary -- all email flows through it, enforces approval gate
- **Subdomain isolation** -- `agent.magistermarketing.com` so root domain email is unaffected
- **Catch-all inbound** -- Resend MX processes all mail to the subdomain, Gateway routes by `to` address lookup
- **Approval-gated outbound** -- agents can only draft (`status=pending`), humans approve via Gateway endpoint
- **Content scanning** -- inbound emails checked for executables, phishing keywords, dangerous HTML; quarantined if unsafe
- **Email threading** -- RFC 2822 In-Reply-To / References headers for proper Gmail/Outlook thread grouping

## Architecture

```
INBOUND:  External sender -> Resend MX -> Webhook POST -> Gateway /webhooks/email/inbound -> scan -> Supabase
OUTBOUND: Agent -> Gateway POST /email/draft (pending) -> User POST /email/approve -> Resend API -> Recipient
```

## Steps Completed (PR #39 - ee/feature/agent-email)

### 1. Brainstorming & Planning
- Explored approaches: Gateway relay, mock inbox, per-agent mailbox
- Settled on Resend (catch-all inbound + API outbound) with Gateway as security boundary
- Wrote full implementation plan at `docs/plans/2026-03-04-agent-email.md`
- Plan reviewed as principal engineer -- merged tasks, fixed security issues, added collision handling

### 2. Database Migration
- Created `webapp/supabase/migrations/20260304200000_create_agent_emails.sql`
- `agent_emails` table: direction, status (pending/approved/sent/rejected/received/quarantined/failed), email fields, threading (message_id, in_reply_to, references_header, thread_id), attachments (JSONB), scan results, timestamps
- Added `email_address TEXT UNIQUE` column to `user_machines`
- RLS policies, indexes, updated_at trigger

### 3. Gateway Config & Models
- Added to `Settings`: `resend_api_key`, `agent_email_domain`, `resend_webhook_secret`
- Added `EmailDraftRequest` model (agent creates drafts)
- Added `EmailApprovalRequest` model with `Literal["approve", "reject"]` validation
- Added `email_address` field to `UserMachine` model

### 4. Provision Flow
- Auto-generates `agent-{userId[:8]}@agent.magistermarketing.com` during machine provisioning
- Collision handling: falls back to full UUID if short prefix collides
- Sets `AGENT_EMAIL_ADDRESS` as Fly machine secret so agent knows its own address

### 5. Supabase Service Methods
- 9 new methods on `SupabaseService`: `get_machine_by_email`, `create_agent_email`, `update_agent_email`, `get_agent_email`, `get_agent_email_by_message_id`, `get_machine_by_token_hash`, `get_agent_emails` (with filters), `get_pending_outbound_emails`

### 6. EmailService (Resend Integration)
- `send_email()` -- calls Resend API via httpx with attachments, cc/bcc, custom headers
- `scan_inbound_content()` -- checks for dangerous attachments, phishing keywords, XSS patterns
- `build_threading_headers()` -- constructs In-Reply-To and References for proper threading
- `verify_webhook_signature()` -- HMAC-SHA256 verification for Resend/Svix webhooks
- `generate_message_id()` -- unique Message-IDs scoped to agent domain

### 7. Inbound Email Webhook Route
- `POST /webhooks/email/inbound` -- receives Resend webhooks
- Verifies Svix signature, routes by to-address, scans content, quarantines if unsafe
- Resolves thread_id from in_reply_to for thread grouping
- Stores in Supabase with full metadata

### 8. Outbound Email Routes
- `POST /api/email/draft` (machine token auth) -- agent creates pending draft, NEVER sends
- `POST /api/email/approve` (JWT auth) -- user approves (sends via Resend) or rejects
- `GET /api/email/pending`, `/inbox`, `/sent` (JWT auth) -- query endpoints
- Security: ownership checks, status validation, no direct send path

### 9. Route Registration
- Wired EmailService, email routes, and webhook route into Gateway `main.py` lifespan
- All 154 tests passing (22 new + 132 existing), gateway lint clean

## Current Status

**PR #39 merged/ready**: All gateway backend work is complete. No current failures.

## What To Work On Next

### DNS Setup (Manual, One-Time - Do First)
1. Add `agent.magistermarketing.com` subdomain in DNS provider
2. In Resend dashboard: add as sending domain (DKIM/SPF) + receiving domain (MX)
3. Add MX record: `agent.magistermarketing.com MX 10 inbound-smtp.resend.com`
4. Create Resend webhook -> `https://magister-gateway.fly.dev/webhooks/email/inbound` (event: `email.received`)
5. Set `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` env vars on gateway

### Webapp UI (Next PR)
- Email inbox/outbox component in settings or chat view
- Pending approval notifications (badge/count)
- Approve/reject buttons for pending outbound emails
- Email thread view

### OpenClaw Email Tool (Next PR)
- Add `send_email` tool to agent so it can draft emails autonomously
- Add `read_inbox` tool so agent can check for new emails
- These call Gateway `/api/email/draft` and `/api/email/inbox`

### Real-Time Notifications (Future)
- Push pending email notifications to webapp via SSE or polling
- So user knows immediately when agent wants to send an email

### Nice-to-Haves (Future)
- Attachment storage in Supabase Storage (instead of inline JSONB)
- Per-plan email quotas
- Enhanced scanning (VirusTotal for attachments)
- User-configurable agent display name, signature, auto-reply rules
