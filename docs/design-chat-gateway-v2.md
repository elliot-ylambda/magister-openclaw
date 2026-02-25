# Design: Chat Gateway v2 — OpenClaw Integration via `/v1/chat/completions`

## Problem

The Python gateway's chat proxy (`POST /api/chat`) targets an endpoint that doesn't exist on OpenClaw (`/api/chat` is a GET-only WebChat HTML page). `POST /api/chat` returns 405. Chat is broken.

## Solution

Switch to OpenClaw's documented HTTP SSE endpoint: `POST /v1/chat/completions` (OpenAI-compatible format). Store chat history in Supabase so the webapp can display past messages on page load.

## Architecture

```
Webapp (Next.js)
  │
  │  POST /api/chat  { message, session_id, stream: true }
  │  ← SSE: event:chunk  data:<plain text token>
  ▼
Python Gateway (FastAPI)
  │
  │  POST /v1/chat/completions  { model, messages, stream: true }
  │  Header: x-openclaw-session-key: webchat:<session_id>
  │  Header: Authorization: Bearer <gateway_token>
  │  ← SSE: data: {"choices":[{"delta":{"content":"token"}}]}
  ▼
OpenClaw Machine (port 18789)
```

The Python gateway translates between the webapp's simple format and OpenAI's format, and parses JSON SSE → plain text SSE. The webapp never sees OpenAI JSON.

---

## Changes

### 1. OpenClaw Config — Enable chat completions endpoint

**File:** `openclaw-image/default-config/openclaw.json`

Add gateway config to enable the `/v1/chat/completions` endpoint and set auth:

```json
{
  "agents": { ... },
  "gateway": {
    "auth": {
      "mode": "token"
    },
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

The `GATEWAY_TOKEN` env var (already injected by `entrypoint.sh` into credentials) is used for bearer auth. OpenClaw reads the token from `gateway.auth.token` or accepts it via the credentials file.

**Local dev setup:** The `entrypoint.sh` only copies `default-config/` on first boot (when `openclaw.json` doesn't exist). For running containers, either:
- Delete the volume and restart: `docker compose down -v && docker compose up -d`
- Or manually update the config inside the container

After changing this file, rebuild the image: `make image-build`.

---

### 2. Python Gateway — Rewrite chat proxy

**File:** `gateway/app/routes/chat.py`

#### Request transformation

Current (broken):
```python
client.stream("POST", f"{machine_url}/api/chat",
    json={"message": req.message, "session_id": req.session_id})
```

New:
```python
client.stream("POST", f"{machine_url}/v1/chat/completions",
    json={
        "model": "openclaw",
        "messages": [{"role": "user", "content": req.message}],
        "stream": True,
    },
    headers={
        "Authorization": f"Bearer {machine.gateway_token}",
        "x-openclaw-session-key": f"webchat:{req.session_id}" if req.session_id else "",
    })
```

Key decisions:
- **`model: "openclaw"`** — OpenClaw ignores this value (uses its configured model) but the field is required by the OpenAI schema.
- **`messages`** — Only the latest user message. OpenClaw maintains full conversation context within the session (identified by `x-openclaw-session-key`). No need to send history.
- **`x-openclaw-session-key`** — Maps the webapp's session UUID to an OpenClaw session. Format: `webchat:<uuid>`. This gives deterministic session routing — same webapp session always resumes the same OpenClaw conversation.

#### Response parsing

Current (broken — forwards raw lines):
```python
async for line in resp.aiter_lines():
    if not line:
        continue
    yield {"event": "chunk", "data": line}
```

New — parse OpenAI JSON SSE, extract content deltas:
```python
async for line in resp.aiter_lines():
    if not line or not line.startswith("data: "):
        continue
    payload = line[6:]  # strip "data: "
    if payload == "[DONE]":
        break
    try:
        chunk = json.loads(payload)
        content = chunk["choices"][0]["delta"].get("content", "")
        if content:
            yield {"event": "chunk", "data": content}
    except (json.JSONDecodeError, KeyError, IndexError):
        continue
```

This way the Python gateway emits plain text SSE events. The webapp concatenates them directly — no JSON parsing needed on the frontend.

#### ChatRequest model

**File:** `gateway/app/models.py`

No change needed. The existing `ChatRequest(message, session_id, stream)` model works — the gateway translates it internally.

---

### 3. Supabase — Add `chat_messages` table

**File:** `webapp/supabase/migrations/20260224000000_create_chat_messages.sql`

```sql
CREATE TABLE public.chat_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_role CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX idx_chat_messages_session
    ON public.chat_messages (session_id, created_at ASC);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS: users can only access messages in their own sessions
CREATE POLICY "Users read own messages" ON public.chat_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.chat_sessions cs
            WHERE cs.id = session_id AND cs.user_id = auth.uid()
        )
    );

CREATE POLICY "Users insert own messages" ON public.chat_messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_sessions cs
            WHERE cs.id = session_id AND cs.user_id = auth.uid()
        )
    );
```

No update/delete policies — messages are append-only.

---

### 4. Webapp — Persist and load messages

**File:** `webapp/src/app/(app)/chat/[sessionId]/chat-session-client.tsx`

#### Load history on mount

```typescript
useEffect(() => {
  async function loadHistory() {
    const { data } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (data?.length) {
      setMessages(data.map(m => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: new Date(m.created_at),
      })));
      isFirstMessageRef.current = false;
    }
  }
  loadHistory();
}, [sessionId, supabase]);
```

#### Save messages during chat flow

In `handleSend`:
1. **Before streaming** — save user message to Supabase
2. **After stream completes** — save assistant message to Supabase

```typescript
// Save user message immediately
await supabase.from("chat_messages").insert({
  session_id: sessionId,
  role: "user",
  content,
});

// ... streaming loop ...

// After streaming completes successfully, save assistant reply
const finalContent = /* get from accumulated state */;
if (finalContent) {
  await supabase.from("chat_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: finalContent,
  });
}
```

Also update `chat_sessions.updated_at` after each exchange to keep sidebar ordering fresh (Supabase trigger already handles this on UPDATE).

---

## Session Lifecycle

| Action | Webapp | OpenClaw |
|---|---|---|
| **New chat** | Insert `chat_sessions` row, redirect to `/chat/<uuid>` | First message auto-creates session via `x-openclaw-session-key: webchat:<uuid>` |
| **Continue chat** | Load messages from `chat_messages` table | Session resumes automatically — same key = same context |
| **New session (reset)** | Create new `chat_sessions` row with new UUID | New UUID → new `x-openclaw-session-key` → fresh OpenClaw session |
| **Delete chat** | Delete `chat_sessions` row (cascade deletes messages) | OpenClaw session orphaned (auto-expires via daily reset) |

---

## Implementation Order

1. **OpenClaw config + image rebuild** — enable `/v1/chat/completions`, rebuild image, wipe volume, restart containers, verify with curl
2. **Python gateway `chat.py`** — rewrite `_stream_chat` to use `/v1/chat/completions` + JSON SSE parsing, verify end-to-end through webapp
3. **Supabase migration + webapp persistence** — create `chat_messages` table, load history on mount, save messages on send/receive

Note: The webapp SSE parser (`gateway.ts`) was already fixed — no changes needed there.

---

## What's NOT in scope

- **Session management UI** (compact, reset via REST) — future work
- **Message search** — future work
- **Message editing/deletion** — future work
- **Model selection per chat** — future work (hardcoded to `"openclaw"` for now)
- **Multi-turn message history in API calls** — not needed; OpenClaw maintains context within a session
