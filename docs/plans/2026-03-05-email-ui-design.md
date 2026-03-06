# Agent Email UI - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the webapp UI for the agent email system — a dedicated `/email` page with inbox, pending approvals, and sent tabs, plus a side panel for viewing/approving/editing/rewriting emails.

**Architecture:** New `/email` route in the `(app)` group following existing patterns (server page.tsx + client email-client.tsx). Gateway helpers in `src/lib/gateway.ts` call the existing gateway email endpoints. Sidebar gets a Mail icon with pending count badge. Gateway needs a small update to support "rewrite" and "edit" actions alongside approve/reject.

**Tech Stack:** Next.js App Router, shadcn/ui (Sheet, Badge, Button, Dialog, Textarea, Input, Tabs), Lucide icons, Tailwind CSS v4, Supabase client, DOMPurify for HTML sanitization

---

### Task 1: Add "rewrite" and "edit" actions to gateway EmailApprovalRequest

The gateway currently only supports `approve | reject`. We need `rewrite` (send note back to agent) and `edit` (user modifies content, then sends).

**Files:**
- Modify: `gateway/app/models.py:132-137`
- Modify: `gateway/app/routes/email.py:59-125`
- Modify: `gateway/tests/test_routes/test_email.py`

**Step 1: Update EmailApprovalRequest model**

In `gateway/app/models.py`, change:
```python
class EmailApprovalRequest(BaseModel):
    """User approves, rejects, edits, or requests rewrite of a pending outbound email."""
    email_id: str
    action: Literal["approve", "reject", "rewrite", "edit"]
    rejection_reason: str | None = None
    rewrite_note: str | None = None
    # For edit action — user-modified fields
    edited_subject: str | None = None
    edited_body_html: str | None = None
    edited_body_text: str | None = None
```

**Step 2: Add rewrite and edit handling to approve route**

In `gateway/app/routes/email.py`, after the reject block, add:

```python
if request.action == "rewrite":
    await supabase.update_agent_email(
        request.email_id,
        status="rewrite_requested",
        rewrite_note=request.rewrite_note,
    )
    logger.info("Email %s rewrite requested by user %s", request.email_id, user_id)
    return {"status": "rewrite_requested", "email_id": request.email_id}

if request.action == "edit":
    # Update content with user edits, then send
    updates = {}
    if request.edited_subject:
        updates["subject"] = request.edited_subject
    if request.edited_body_html:
        updates["body_html"] = request.edited_body_html
    if request.edited_body_text:
        updates["body_text"] = request.edited_body_text
    if updates:
        await supabase.update_agent_email(request.email_id, **updates)
        # Re-fetch with edits applied
        email = await supabase.get_agent_email(request.email_id)
    # Then fall through to the send logic below...
```

Refactor the send logic (currently in the `approve` path) to be shared between `approve` and `edit`.

**Step 3: Add DB migration for rewrite_requested status and rewrite_note column**

Create `webapp/supabase/migrations/20260305100000_add_email_rewrite_support.sql`:
```sql
-- Add rewrite_requested to status check constraint
ALTER TABLE agent_emails DROP CONSTRAINT IF EXISTS agent_emails_status_check;
ALTER TABLE agent_emails ADD CONSTRAINT agent_emails_status_check
  CHECK (status IN ('pending', 'approved', 'sent', 'rejected', 'received', 'quarantined', 'failed', 'rewrite_requested'));

-- Add rewrite_note column
ALTER TABLE agent_emails ADD COLUMN IF NOT EXISTS rewrite_note TEXT;
```

**Step 4: Update Supabase service to handle new fields**

In `gateway/app/services/supabase_client.py`, ensure `update_agent_email` accepts `rewrite_note`, `subject`, `body_html`, `body_text` as kwargs (it likely already does via **kwargs).

**Step 5: Write tests for rewrite and edit actions**

Add tests in `gateway/tests/test_routes/test_email.py`:
- `test_rewrite_email_sets_status_and_note`
- `test_edit_email_updates_content_and_sends`
- `test_rewrite_requires_pending_status`

**Step 6: Run tests**

Run: `cd /Users/ellioteckholm/projects/magister-marketing/.worktrees/agent-email/gateway && .venv/bin/python -m pytest tests/test_routes/test_email.py -v`
Expected: All pass

**Step 7: Commit**

```bash
git add gateway/app/models.py gateway/app/routes/email.py gateway/tests/test_routes/test_email.py webapp/supabase/migrations/20260305100000_add_email_rewrite_support.sql
git commit -m "feat: add rewrite and edit actions to email approval flow"
```

---

### Task 2: Add email gateway helpers to webapp

**Files:**
- Modify: `webapp/src/lib/gateway.ts`

**Step 1: Add AgentEmail type and email helper functions**

Append to `webapp/src/lib/gateway.ts`:

```typescript
// ── Email operations ────────────────────────────────────────

export type AgentEmail = {
  id: string;
  user_id: string;
  machine_id: string;
  direction: "inbound" | "outbound";
  status: "pending" | "approved" | "sent" | "rejected" | "received" | "quarantined" | "failed" | "rewrite_requested";
  from_address: string;
  to_address: string;
  cc: string[] | null;
  bcc: string[] | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  attachments: Record<string, unknown>[] | null;
  rewrite_note: string | null;
  scan_result: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
};

async function emailRequest<T>(
  gatewayUrl: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}/api${path}`, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Email operation failed (${res.status})`);
  }
  return res.json();
}

export function getPendingEmails(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/pending");
}

export function getEmailInbox(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/inbox");
}

export function getSentEmails(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/sent");
}

export function approveEmail(gatewayUrl: string, jwt: string, emailId: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "approve",
  });
}

export function rejectEmail(gatewayUrl: string, jwt: string, emailId: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "reject",
  });
}

export function rewriteEmail(gatewayUrl: string, jwt: string, emailId: string, note: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "rewrite",
    rewrite_note: note,
  });
}

export function editAndSendEmail(
  gatewayUrl: string,
  jwt: string,
  emailId: string,
  edits: { subject?: string; body_html?: string; body_text?: string }
) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "edit",
    edited_subject: edits.subject,
    edited_body_html: edits.body_html,
    edited_body_text: edits.body_text,
  });
}
```

**Step 2: Commit**

```bash
git add webapp/src/lib/gateway.ts
git commit -m "feat: add email gateway helpers"
```

---

### Task 3: Add shadcn/ui Tabs component

The email page needs tabs but the component isn't installed yet.

**Step 1: Install tabs**

```bash
cd /Users/ellioteckholm/projects/magister-marketing/.worktrees/agent-email/webapp && pnpm dlx shadcn@latest add tabs
```

**Step 2: Commit**

```bash
git add webapp/src/components/ui/tabs.tsx
git commit -m "feat: add shadcn tabs component"
```

---

### Task 4: Install DOMPurify for safe HTML rendering

Email bodies contain HTML that must be sanitized before rendering to prevent XSS.

**Step 1: Install DOMPurify**

```bash
cd /Users/ellioteckholm/projects/magister-marketing/.worktrees/agent-email/webapp && pnpm add dompurify && pnpm add -D @types/dompurify
```

**Step 2: Commit**

```bash
git add webapp/package.json webapp/pnpm-lock.yaml
git commit -m "feat: add DOMPurify for safe email HTML rendering"
```

---

### Task 5: Create email page (server component)

**Files:**
- Create: `webapp/src/app/(app)/email/page.tsx`
- Create: `webapp/src/app/(app)/email/loading.tsx`

**Step 1: Create loading skeleton**

```tsx
// webapp/src/app/(app)/email/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function EmailLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-64" />
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create server page**

```tsx
// webapp/src/app/(app)/email/page.tsx
import { checkAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EmailClient } from "./email-client";

export default async function EmailPage() {
  const { user } = await checkAccess();
  const supabase = await createClient();

  // Get agent email address from user_machines
  const { data: machine } = await supabase
    .from("user_machines_safe")
    .select("email_address")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  return (
    <EmailClient
      agentEmail={machine?.email_address ?? null}
    />
  );
}
```

**Step 3: Commit**

```bash
git add webapp/src/app/\(app\)/email/
git commit -m "feat: add email page server component and loading skeleton"
```

---

### Task 6: Create email client component

This is the main UI — tabs, email list, sheet panel with approve/edit/rewrite/reject actions.

**Files:**
- Create: `webapp/src/app/(app)/email/email-client.tsx`

**Step 1: Build the email client component**

The component should:
- Show three tabs: Pending (default), Inbox, Sent
- Each tab fetches its data via gateway helpers on mount and on tab switch
- Email list shows: from/to, subject, date, status badge
- Clicking a row opens a Sheet (right panel) with:
  - Email header info (from, to, subject, date, status)
  - Email body rendered safely using DOMPurify: `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(email.body_html) }} />` — plain text fallback if no HTML
  - For pending tab: Approve, Edit & Send, Request Rewrite, Reject buttons
  - Edit mode: inline editable subject (Input) and body (Textarea), Save & Send / Cancel
  - Rewrite mode: Textarea for note, Submit / Cancel
- Loading states with Skeleton
- Error states with inline message
- Refresh button per tab

Key patterns to follow (from files-client.tsx / settings-client.tsx):
- Use `createClient()` from `@/lib/supabase/client` to get JWT via `supabase.auth.getSession()`
- Use `NEXT_PUBLIC_GATEWAY_URL` env var
- Use `useState` for: activeTab, emails, selectedEmail, loading, editMode, rewriteMode, editedSubject, editedBody, rewriteNote, actionLoading
- Fetch emails on mount and tab change

**Step 2: Commit**

```bash
git add webapp/src/app/\(app\)/email/email-client.tsx
git commit -m "feat: add email client with tabs, list, and approval actions"
```

---

### Task 7: Add email nav item with pending badge to sidebar

**Files:**
- Modify: `webapp/src/components/shared/app-sidebar.tsx`

**Step 1: Add Mail icon import and pending count state**

Add `Mail` to the lucide-react imports. Add state for pending count. Fetch pending count on mount via Supabase query.

**Step 2: Add Email menu item between Files and Settings in SidebarFooter**

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    onClick={() => router.push("/email")}
    className="gap-2"
  >
    <Mail className="h-4 w-4" />
    Email
    {pendingCount > 0 && (
      <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
        {pendingCount}
      </span>
    )}
  </SidebarMenuButton>
</SidebarMenuItem>
```

**Step 3: Add pending count fetch**

```tsx
const [pendingCount, setPendingCount] = useState(0);

useEffect(() => {
  async function fetchPendingCount() {
    const { count } = await supabase
      .from("agent_emails")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("direction", "outbound");
    setPendingCount(count ?? 0);
  }
  fetchPendingCount();
}, [supabase]);
```

**Step 4: Commit**

```bash
git add webapp/src/components/shared/app-sidebar.tsx
git commit -m "feat: add email nav item with pending badge to sidebar"
```

---

### Task 8: Add email_address to user_machines_safe view (if needed)

Check if `user_machines_safe` view includes `email_address`. If not, update it.

**Files:**
- Possibly create: `webapp/supabase/migrations/20260305100001_add_email_to_safe_view.sql`

**Step 1: Check current view definition**

Look at existing migrations to see how `user_machines_safe` is defined.

**Step 2: If needed, add migration to include email_address**

```sql
CREATE OR REPLACE VIEW user_machines_safe AS
SELECT id, user_id, fly_app_name, fly_region, status, last_activity, plan, max_agents,
       preferred_model, email_address, provisioning_step, created_at, updated_at
FROM user_machines;
```

**Step 3: Commit if migration was needed**

---

### Task 9: Build and lint check

**Step 1: Run full pre-PR check**

```bash
cd /Users/ellioteckholm/projects/magister-marketing/.worktrees/agent-email && make check
```

**Step 2: Run gateway tests**

```bash
make gateway-test
```

**Step 3: Fix any issues and commit**

Expected: webapp build clean, webapp lint clean, gateway lint clean, all tests pass.
