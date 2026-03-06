# Browser Control — Remaining Work Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the browser control feature so it works end-to-end in production — apply the migration, harden the token exchange endpoint, and verify the full flow.

**Architecture:** The feature is ~95% built. The gateway WebSocket relay with CDP policy engine, webapp settings UI, API routes, Supabase service methods, database migration file, and Chrome extension are all implemented. Remaining work is hardening, testing the integration, and deploying.

**Tech Stack:** Python/FastAPI (gateway), Next.js/React (webapp), Supabase (DB), Chrome Extension (MV3)

---

## Current State Summary

### What's Done
- **Gateway:** `browser_relay.py` (WS proxy + policy engine), `browser_token.py` (token generate/exchange), 23 tests passing
- **Webapp:** `/api/browser/policy`, `/api/browser/status`, `/api/browser/token` API routes; `BrowserControl` settings component with toggles, URL allowlist, token generation; `/extension` marketing page; sidebar link
- **Database:** Migration file `20260305100000_add_browser_control.sql` — adds `browser_enabled`, `browser_allowed_urls`, `browser_read_only` to `user_machines`; creates `browser_connection_tokens` table with RLS
- **Models:** `UserMachine` has `browser_enabled`, `browser_allowed_urls`, `browser_read_only` fields
- **Chrome Extension:** Already rebranded ("Magister Browser Control"), supports gateway mode via `buildGatewayWsUrl()`, token-based auth via options page, dual mode (gateway/local)

### Field Mapping (verified consistent)
| Database | Webapp API | Component | Gateway Model |
|----------|-----------|-----------|---------------|
| `browser_enabled` | `enabled` | `policy.enabled` | `browser_enabled` |
| `browser_read_only` | `readOnly` | `policy.readOnly` | `browser_read_only` |
| `browser_allowed_urls` | `allowedUrls` | `policy.allowedUrls` | `browser_allowed_urls` |

### What's Remaining
1. **Task 1:** Apply migration to production Supabase
2. **Task 2:** Add rate limiting to token exchange endpoint
3. **Task 3:** Add expired token cleanup
4. **Task 4:** End-to-end integration test
5. **Task 5:** Deploy

---

### Task 1: Apply Database Migration to Production

The migration file already exists at `webapp/supabase/migrations/20260305100000_add_browser_control.sql`. It needs to be applied to the production Supabase instance.

**Files:**
- Existing: `webapp/supabase/migrations/20260305100000_add_browser_control.sql`

**Step 1: Review migration is correct**

Verify the migration adds:
- `browser_enabled BOOLEAN NOT NULL DEFAULT false` to `user_machines`
- `browser_allowed_urls TEXT[] NOT NULL DEFAULT '{}'` to `user_machines`
- `browser_read_only BOOLEAN NOT NULL DEFAULT false` to `user_machines`
- Recreates `user_machines_safe` view including new columns
- Creates `browser_connection_tokens` table with RLS

**Step 2: Test locally**

```bash
make supabase-reset
```

Expected: migration applies cleanly, seed data works.

**Step 3: Apply to production**

```bash
cd webapp && npx supabase db push
```

Expected: migration applies without errors.

**Step 4: Verify columns exist**

```sql
SELECT browser_enabled, browser_allowed_urls, browser_read_only
FROM user_machines LIMIT 1;
```

Expected: returns defaults (false, {}, false).

---

### Task 2: Rate-Limit Token Exchange Endpoint

**Problem:** The `/api/browser/token/exchange` endpoint has no rate limiting. An attacker could brute-force connection tokens.

**Files:**
- Modify: `gateway/app/routes/browser_token.py`
- Test: `gateway/tests/test_routes/test_browser_token.py`

**Step 1: Write the failing test**

Add to `gateway/tests/test_routes/test_browser_token.py`:

```python
def test_exchange_rate_limited_after_failures(mock_supabase):
    """After 5 failed attempts, subsequent requests should be rejected."""
    mock_supabase.get_browser_token = AsyncMock(return_value=None)
    client = _make_client(mock_supabase)

    # Make 5 failed attempts
    for _ in range(5):
        resp = client.post("/api/browser/token/exchange", json={"token": "bad"})
        assert resp.status_code == 401

    # 6th attempt should be rate limited
    resp = client.post("/api/browser/token/exchange", json={"token": "bad"})
    assert resp.status_code == 429
```

**Step 2: Run test to verify it fails**

```bash
cd gateway && .venv/bin/python -m pytest tests/test_routes/test_browser_token.py::test_exchange_rate_limited_after_failures -v
```

Expected: FAIL (returns 401, not 429)

**Step 3: Implement rate limiting**

In `gateway/app/routes/browser_token.py`, add a simple in-memory rate limiter for failed exchange attempts:

```python
import time
from collections import defaultdict

# Track failed exchange attempts: IP -> list of timestamps
_exchange_failures: dict[str, list[float]] = defaultdict(list)
MAX_EXCHANGE_FAILURES = 5
EXCHANGE_WINDOW_SECONDS = 300  # 5 minutes
```

In `exchange_token`, before validating:
```python
# Rate limit check
client_ip = req_raw.client.host if req_raw.client else "unknown"
now = time.time()
_exchange_failures[client_ip] = [
    t for t in _exchange_failures[client_ip]
    if now - t < EXCHANGE_WINDOW_SECONDS
]
if len(_exchange_failures[client_ip]) >= MAX_EXCHANGE_FAILURES:
    raise HTTPException(status_code=429, detail="Too many failed attempts")
```

After failed validation:
```python
_exchange_failures[client_ip].append(now)
```

Add `Request` parameter: `req_raw: Request` to the endpoint.

**Step 4: Run test to verify it passes**

```bash
cd gateway && .venv/bin/python -m pytest tests/test_routes/test_browser_token.py -v
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add gateway/app/routes/browser_token.py gateway/tests/test_routes/test_browser_token.py
git commit -m "feat: rate-limit browser token exchange after failed attempts"
```

---

### Task 3: Expired Token Cleanup

**Problem:** `browser_connection_tokens` accumulates expired entries over time. They're filtered in queries but never deleted.

**Files:**
- Modify: `webapp/supabase/migrations/20260305100000_add_browser_control.sql` (or create new migration)
- Alternative: add cleanup in `gateway/app/services/supabase_client.py`

**Recommended approach:** Add a gateway-side cleanup method called periodically, keeping it simple.

**Step 1: Add cleanup method to supabase service**

In `gateway/app/services/supabase_client.py`, in the Browser Control section:

```python
async def cleanup_expired_browser_tokens(self) -> int:
    """Delete expired or used browser connection tokens. Returns count deleted."""
    result = await (
        self._client.table("browser_connection_tokens")
        .delete()
        .or_(f"used.eq.true,expires_at.lt.{datetime.now(timezone.utc).isoformat()}")
        .execute()
    )
    return len(result.data) if result.data else 0
```

**Step 2: Call it in the reconciliation job**

In `gateway/app/jobs/reconciliation.py`, add a call to `cleanup_expired_browser_tokens()` in the periodic loop (runs every 5 minutes already).

**Step 3: Commit**

```bash
git add gateway/app/services/supabase_client.py gateway/app/jobs/reconciliation.py
git commit -m "feat: periodic cleanup of expired browser connection tokens"
```

---

### Task 4: End-to-End Integration Verification

**Step 1: Start local stack**

```bash
make up
make supabase-reset
make webapp-dev
```

**Step 2: Verify settings UI**

1. Log in as dev user
2. Navigate to Settings
3. Find "Browser Control" card
4. Toggle "Enable browser control" ON
5. Click "Generate Token" — should show a token with expiry countdown
6. Toggle "Read-only mode" on/off
7. Add a domain to the URL allowlist (e.g., "google.com")
8. Remove the domain

**Step 3: Verify API routes**

```bash
# Get policy (needs auth cookie — do via browser DevTools)
curl http://localhost:3020/api/browser/policy

# Check status
curl http://localhost:3020/api/browser/status
```

**Step 4: Verify gateway endpoints**

```bash
# Token exchange (use a generated token from the UI)
curl -X POST http://localhost:8080/api/browser/token/exchange \
  -H "Content-Type: application/json" \
  -d '{"token": "<paste-token>"}'

# Browser status
curl "http://localhost:8080/api/browser/status?user_id=<user-id>"
```

**Step 5: Test Chrome extension (if possible)**

1. Load extension unpacked from `magister-openclaw/assets/chrome-extension/`
2. Open extension options page
3. Paste connection token from settings
4. Should exchange token and show "Connected"

---

### Task 5: Deploy

**Step 1: Run pre-PR checks**

```bash
make check
```

Expected: webapp build + lint + gateway lint all pass.

**Step 2: Run all tests**

```bash
make gateway-test
cd webapp && pnpm test:run
```

**Step 3: Push and create PR**

```bash
git push origin ee/feature/chrome-extension
```

Create PR against main with summary of the browser control feature.

**Step 4: Deploy after merge**

```bash
make deploy-backend   # deploys image + gateway + machines
```

The migration needs to be applied to production Supabase separately via `npx supabase db push`.
