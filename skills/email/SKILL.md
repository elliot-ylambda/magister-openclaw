---
name: email
description: Send and receive emails through the Magister gateway. Draft outbound emails for user approval, read inbox, check sent/pending status, and handle rewrite requests.
metadata: { "openclaw": { "always": true } }
---

# Email

## Overview

You have a dedicated email address: `$AGENT_EMAIL_ADDRESS`

All outbound emails go through an **approval gate** — you draft, the user approves (or requests a rewrite), then the gateway sends via Resend. Inbound emails are forwarded to you automatically as chat messages.

**Gateway base URL:** `http://magister-gateway.internal:8081`
**Auth:** `-H "Authorization: Bearer $GATEWAY_TOKEN"`

## Drafting an Email

```bash
curl -s -X POST http://magister-gateway.internal:8081/api/email/draft \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "recipient@example.com",
    "subject": "Subject line",
    "body_html": "<p>HTML body</p>",
    "body_text": "Plain text fallback",
    "cc": "optional@example.com",
    "bcc": "optional@example.com",
    "reply_to": "optional-reply-to@example.com"
  }'
```

Response: `{"status": "pending", "email_id": "..."}`

The email is now **pending** — the user will see it in their dashboard and can approve, reject, edit, or request a rewrite.

## Replying to an Email

To reply to an inbound email, set `in_reply_to` to the original email's `message_id` field:

```bash
curl -s -X POST http://magister-gateway.internal:8081/api/email/draft \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "sender@example.com",
    "subject": "Re: Original Subject",
    "body_html": "<p>Reply body</p>",
    "body_text": "Reply body",
    "in_reply_to": "<original-message-id@example.com>"
  }'
```

## Reading Inbox

```bash
curl -s http://magister-gateway.internal:8081/api/email/agent/inbox \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Optional query params: `?since=2026-03-01T00:00:00Z&limit=20`

## Reading Sent Emails

```bash
curl -s http://magister-gateway.internal:8081/api/email/agent/sent \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Optional query params: `?since=2026-03-01T00:00:00Z&limit=20`

## Checking Pending / Rewrite Requests

```bash
curl -s http://magister-gateway.internal:8081/api/email/agent/pending \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Returns emails with status `pending` or `rewrite_requested`. If a rewrite is requested, the `rewrite_note` field contains the user's feedback.

## Reading a Specific Email

```bash
curl -s http://magister-gateway.internal:8081/api/email/agent/{email_id} \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

## Handling Rewrite Requests

1. Check pending: `GET /api/email/agent/pending`
2. Find emails with `status: "rewrite_requested"`
3. Read the `rewrite_note` for the user's feedback
4. Draft a new email incorporating the feedback (same `to`/`subject`, improved content)

## Inbound Email Notifications

When someone emails your address, the gateway automatically forwards it to you as a chat message. The message includes the sender, subject, body, and email ID. You can then:
- Read the full email: `GET /api/email/agent/{email_id}`
- Reply: `POST /api/email/draft` with `in_reply_to` set to the original `message_id`

## Guidelines

- Always provide both `body_html` and `body_text` for maximum compatibility
- Keep a professional, helpful tone appropriate for marketing communications
- Never attempt to send emails directly — always use the draft endpoint
- Respect the approval gate: the user has final say on all outbound emails
- When handling rewrite requests, address every point in the `rewrite_note`
