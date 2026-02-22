# Webapp Extension — Chat UI, Admin Dashboard, Stripe & Auth

**Date:** 2026-02-21
**Status:** Draft
**Authors:** Elliot Eckholm
**Depends on:** `2026-02-18-magister-multi-tenant-agent-infra-design.md` (backend infra)

## Overview

Extend the Magister Marketing Next.js webapp from a single-page marketing site into a full SaaS application with:
- **Auth** — Email + password signup/login via Supabase Auth
- **Stripe Checkout** — Subscription purchase flow with billing portal
- **Chat UI** — Real-time agent interaction with SSE streaming, tool-use visibility, session management
- **Admin Dashboard** — Internal ops panel for monitoring users, agents, cost, and machine state
- **User Dashboard** — Personal usage stats and account settings

**Scope:** Frontend (Next.js) and database schema only. The Gateway backend already exists.

### Non-Goals

- Modifying the Gateway (FastAPI) — all Gateway endpoints already exist
- Refactoring the existing landing page (`page.tsx`)
- OAuth/social login (email + password only for launch)
- Mobile app or PWA
- Real-time collaboration or multi-user chat

---

## User Flows

### New User: Signup → Subscribe → Chat

```
Landing page (/)
  └── Click "Get Started"
        └── /signup — create account (email + password)
              └── Email confirmation (Supabase sends verification)
                    └── /auth/callback — verify token, redirect
                          └── /pricing — select plan
                                └── Stripe Checkout (hosted)
                                      └── Webhook: create subscription, trigger provision
                                            └── /chat — "Setting up your agent..." → ready
```

### Returning User: Login → Chat

```
/login — email + password
  └── /chat — session sidebar, start new or resume conversation
```

### Admin: Internal Operations

```
/admin — requires role = "admin"
  └── User list: status, plan, LLM spend, last active
  └── Machine controls: restart, suspend
  └── Aggregate cost analytics
```

---

## Architecture

### Route Structure

```
webapp/src/
├── app/
│   ├── page.tsx                           # Landing page (existing, unchanged)
│   ├── layout.tsx                         # Root layout (existing, add auth provider)
│   ├── middleware.ts                      # → src/middleware.ts (auth + route protection)
│   │
│   ├── (auth)/                            # Auth pages (centered card layout)
│   │   ├── layout.tsx                     # Minimal centered layout
│   │   ├── login/page.tsx                 # Email + password login
│   │   ├── signup/page.tsx                # Registration
│   │   └── reset-password/page.tsx        # Password reset request + update
│   │
│   ├── pricing/page.tsx                   # Public pricing page (Stripe checkout links)
│   │
│   ├── (app)/                             # Authenticated app (sidebar layout)
│   │   ├── layout.tsx                     # App shell: sidebar + header + user nav
│   │   ├── chat/
│   │   │   ├── page.tsx                   # New chat (redirect to /chat/[sessionId])
│   │   │   └── [sessionId]/page.tsx       # Active chat session
│   │   ├── dashboard/page.tsx             # User dashboard (agent status, usage)
│   │   └── settings/page.tsx              # Account settings
│   │
│   ├── (admin)/                           # Admin area (admin layout + role guard)
│   │   ├── layout.tsx                     # Admin layout with nav
│   │   └── admin/
│   │       ├── page.tsx                   # Overview dashboard
│   │       └── users/page.tsx             # User management table
│   │
│   ├── auth/
│   │   └── callback/route.ts              # Supabase auth callback (email confirm, password reset)
│   │
│   └── api/
│       ├── stripe/
│       │   ├── checkout/route.ts          # Create Stripe Checkout session
│       │   └── portal/route.ts            # Create Stripe billing portal session
│       ├── admin/
│       │   └── machines/route.ts          # Admin proxy to Gateway (restart/suspend) — keeps GATEWAY_API_KEY server-side
│       └── billing/
│           └── webhook/route.ts           # (existing) — extend with subscription sync
│
├── components/
│   ├── ui/                                # shadcn/ui components (expanded)
│   ├── chat/                              # Chat-specific components
│   │   ├── chat-input.tsx                 # Message input with send button
│   │   ├── chat-message.tsx               # Message bubble (user + agent)
│   │   ├── chat-sidebar.tsx               # Session list sidebar
│   │   ├── tool-use-display.tsx           # Agent tool use visualization
│   │   ├── thinking-indicator.tsx         # Agent thinking/working animation
│   │   └── agent-status-badge.tsx         # Running/suspended/waking indicator
│   ├── admin/                             # Admin components
│   │   ├── users-table.tsx                # Sortable/filterable user table
│   │   ├── machine-controls.tsx           # Restart/suspend buttons
│   │   └── spend-overview.tsx             # Aggregate cost display
│   └── shared/                            # Cross-cutting components
│       ├── user-nav.tsx                   # User avatar + dropdown (settings, logout)
│       ├── app-sidebar.tsx                # App navigation sidebar
│       └── supabase-provider.tsx          # Client-side Supabase auth context
│
├── lib/
│   ├── supabase/
│   │   ├── server.ts                      # createServerClient (cookies-based)
│   │   ├── client.ts                      # createBrowserClient (singleton)
│   │   └── middleware.ts                  # Auth middleware helper
│   ├── stripe.ts                          # Server-side Stripe client
│   ├── gateway.ts                         # Gateway API client (chat, status)
│   ├── resend.ts                          # (existing)
│   ├── unsubscribe.ts                     # (existing)
│   └── utils.ts                           # (existing)
│
└── middleware.ts                           # Next.js edge middleware (auth checks)
```

### Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                      │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Next.js App (Vercel)                                    │  │
│  │                                                          │  │
│  │  Client Components:                                      │  │
│  │  ├── ChatInput → POST /api/chat (Gateway) → SSE stream  │  │
│  │  ├── AdminTable → Server Components → Supabase queries   │  │
│  │  └── StripeCheckout → /api/stripe/checkout → redirect    │  │
│  │                                                          │  │
│  │  Server Components:                                      │  │
│  │  ├── Dashboard → Supabase (user_machines, usage_events)  │  │
│  │  ├── Admin → Supabase (all users, service role)          │  │
│  │  └── Chat Sidebar → Supabase (chat_sessions)             │  │
│  │                                                          │  │
│  │  API Routes:                                             │  │
│  │  ├── /api/stripe/checkout → Stripe API                   │  │
│  │  ├── /api/stripe/portal → Stripe API                     │  │
│  │  └── /api/billing/webhook → Gateway /api/provision       │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  Direct connections (client-side):                             │
│  ├── Chat SSE → Gateway /api/chat (JWT auth)                  │
│  └── Supabase Auth → Supabase (signup, login, session)        │
└──────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

**1. Chat streams directly to Gateway (not via Next.js API route)**
The chat UI connects directly to the Gateway's `/api/chat` endpoint with the Supabase JWT. This avoids double-proxying through Vercel and allows true SSE streaming without serverless function timeouts.

**2. Admin reads via Supabase, admin actions via Gateway**
Admin read operations (user list, spend data) query Supabase directly from Server Components using the service-role key. Admin write operations (restart/suspend machine) call the Gateway with an API key. This avoids adding new Gateway endpoints for reads.

**3. Session metadata in Supabase, message history in OpenClaw**
Chat session metadata (id, title, created_at) is stored in Supabase for the sidebar. Actual message content lives on the OpenClaw volume. The frontend keeps messages in local state during the session. Full message history replay is a future enhancement.

**4. Stripe Checkout (hosted) — not embedded**
Use Stripe's hosted Checkout page rather than embedded Elements. Simpler, PCI-compliant out of the box, and handles all edge cases (3D Secure, failed payments, retries).

---

## Database Schema Changes

### New Tables

```sql
-- User profiles (auto-created on signup via trigger)
CREATE TABLE profiles (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    display_name        TEXT,
    avatar_url          TEXT,
    role                TEXT NOT NULL DEFAULT 'user',  -- 'user' or 'admin'
    stripe_customer_id  TEXT UNIQUE,
    onboarded_at        TIMESTAMPTZ,                   -- null until first chat
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_role CHECK (role IN ('user', 'admin'))
);

-- Stripe subscription tracking
CREATE TABLE subscriptions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_subscription_id  TEXT NOT NULL UNIQUE,
    stripe_price_id         TEXT NOT NULL,
    plan                    TEXT NOT NULL DEFAULT 'cmo',
    status                  TEXT NOT NULL DEFAULT 'active',
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    cancel_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_plan CHECK (plan IN ('cmo', 'cmo_plus')),
    CONSTRAINT valid_status CHECK (status IN (
        'active', 'canceled', 'incomplete', 'incomplete_expired',
        'past_due', 'trialing', 'unpaid', 'paused'
    ))
);

-- Chat session metadata (for sidebar display)
CREATE TABLE chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New conversation',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_profiles_stripe ON profiles (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions (stripe_subscription_id);
CREATE INDEX idx_chat_sessions_user ON chat_sessions (user_id, updated_at DESC);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Auto-update timestamps
CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

CREATE TRIGGER subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

CREATE TRIGGER chat_sessions_updated_at
    BEFORE UPDATE ON chat_sessions
    FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- RLS policies
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- Profiles: users read own, admins read all
CREATE POLICY "Users read own profile" ON profiles
    FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile EXCEPT the role column.
-- Role changes are only allowed via service-role key (admin actions).
CREATE POLICY "Users update own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (
        auth.uid() = id
        AND role = (SELECT role FROM profiles WHERE id = auth.uid())
    );

-- Subscriptions: users read own
CREATE POLICY "Users read own subscriptions" ON subscriptions
    FOR SELECT USING (auth.uid() = user_id);

-- Chat sessions: users CRUD own
CREATE POLICY "Users read own sessions" ON chat_sessions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users create own sessions" ON chat_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own sessions" ON chat_sessions
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users delete own sessions" ON chat_sessions
    FOR DELETE USING (auth.uid() = user_id);
```

---

## Testing Strategy

### Stack
- **Vitest** — test runner (fast, Vite-based, works well with Next.js App Router)
- **React Testing Library** — component unit tests
- **MSW (Mock Service Worker)** — mock Gateway and Stripe APIs in integration tests
- **Supabase local** — real database for integration tests (already running via `make db-start`)

### Test Structure

```
webapp/
├── vitest.config.ts                      # Vitest configuration
├── src/
│   ├── __tests__/
│   │   ├── setup.ts                      # Global test setup (MSW, RTL matchers)
│   │   ├── mocks/
│   │   │   ├── handlers.ts               # MSW request handlers (Gateway, Stripe)
│   │   │   ├── supabase.ts               # Supabase client mock factory
│   │   │   └── server.ts                 # MSW server setup
│   │   ├── integration/
│   │   │   ├── auth-flow.test.ts         # Signup → login → redirect flow
│   │   │   ├── stripe-checkout.test.ts   # Checkout session creation + webhook
│   │   │   ├── chat-session.test.ts      # Message send → stream → display
│   │   │   ├── admin-access.test.ts      # Admin role guard + data display
│   │   │   └── middleware.test.ts        # Route protection integration
│   │   └── unit/
│   │       ├── gateway-client.test.ts    # SSE parsing, retry logic
│   │       ├── stripe-webhook.test.ts    # Event parsing, subscription sync
│   │       └── middleware-logic.test.ts  # Route matching, redirect logic
│   ├── components/
│   │   ├── chat/
│   │   │   ├── __tests__/
│   │   │   │   ├── chat-message.test.tsx
│   │   │   │   ├── chat-input.test.tsx
│   │   │   │   ├── tool-use-display.test.tsx
│   │   │   │   └── chat-sidebar.test.tsx
│   │   ├── admin/
│   │   │   ├── __tests__/
│   │   │   │   ├── users-table.test.tsx
│   │   │   │   └── machine-controls.test.tsx
│   │   └── shared/
│   │       ├── __tests__/
│   │       │   ├── user-nav.test.tsx
│   │       │   └── agent-status-badge.test.tsx
│   └── lib/
│       ├── __tests__/
│       │   ├── gateway.test.ts
│       │   └── stripe.test.ts
```

### Test Categories

**Unit tests** — isolated component/function behavior with mocked dependencies:
- Component rendering and user interactions (RTL)
- Gateway client SSE parsing and error handling
- Stripe webhook event parsing and handler dispatch
- Middleware route-matching logic

**Integration tests** — multi-component flows with MSW-mocked APIs:
- Auth flow: signup form → Supabase auth → redirect chain
- Stripe flow: checkout creation → webhook processing → subscription state
- Chat flow: message input → Gateway SSE stream → message display
- Admin flow: role verification → data queries → machine controls

All integration tests use MSW to mock the Gateway and Stripe APIs while keeping component rendering real. Database integration tests run against local Supabase.

---

## Phase 1: Auth Foundation

### Task 0: Install Dependencies & Environment Setup

**This task runs first** — all subsequent tasks depend on these packages and env vars.

**Dependencies:**
```bash
# Auth
pnpm add @supabase/ssr

# UI components (needed starting Phase 2)
pnpm dlx shadcn@latest add card dialog dropdown-menu avatar tabs table \
  scroll-area separator skeleton toast textarea tooltip sheet sidebar

# Markdown rendering (needed in Phase 4)
pnpm add react-markdown remark-gfm rehype-highlight

# Testing
pnpm add -D vitest @vitejs/plugin-react jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  msw
```

**Environment Variables** — add to `.env.local` / `.env.example`:
```bash
# Stripe (needed from Phase 3)
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_CMO_PRICE_ID=price_...
STRIPE_CMO_PLUS_PRICE_ID=price_...

# Gateway (needed from Phase 4)
NEXT_PUBLIC_GATEWAY_URL=https://magister-gateway.fly.dev
GATEWAY_API_KEY=...
```

**Migrate `actions.ts`** — update the existing `src/app/actions.ts` to use the new `lib/supabase/server.ts` utilities (created in Task 3) instead of creating its own Supabase client. This ensures a single pattern for Supabase client creation across the app.

---

### Task 1: Test Setup & Configuration

**Files:**
- Create: `webapp/vitest.config.ts`
- Create: `webapp/src/__tests__/setup.ts`
- Create: `webapp/src/__tests__/mocks/supabase.ts`
- Create: `webapp/src/__tests__/mocks/handlers.ts`
- Create: `webapp/src/__tests__/mocks/server.ts`
- Add: `"test": "vitest"` to `webapp/package.json` scripts

**vitest.config.ts:**
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: true,
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

**setup.ts** — imports `@testing-library/jest-dom`, sets up MSW server (beforeAll/afterAll/afterEach).

**mocks/supabase.ts** — factory that creates a mock Supabase client with chainable query builder (`.from().select().eq()` etc.), mock auth methods, and configurable return values.

**mocks/handlers.ts** — MSW request handlers for:
- Gateway: `POST /api/chat`, `GET /api/status`, `POST /api/provision`, `POST /api/destroy`
- Stripe: `POST /v1/checkout/sessions`, `POST /v1/billing_portal/sessions`

---

### Task 2: Supabase Migration — profiles, subscriptions, chat_sessions

**Files:**
- Create: `webapp/supabase/migrations/20260221000000_create_profiles_subscriptions_sessions.sql`

Write the migration with all three tables, triggers, indexes, and RLS policies as specified in the schema section above.

**Verify:**
```bash
cd webapp && make supabase-migrate-local
```

**Integration test** — `src/__tests__/integration/database.test.ts`:
- Verify migration applies cleanly against local Supabase
- Insert a test user into `auth.users` → verify `profiles` row auto-created via trigger
- Verify RLS: authenticated user can only read own profile, not others
- Verify `chat_sessions` CRUD respects RLS (user can only access own sessions)
- Verify `subscriptions` read-only for authenticated users (no insert/update/delete via client)
- Verify `handle_updated_at` trigger fires on profile and subscription updates

---

### Task 3: Supabase Auth Utilities

**Files:**
- Install: `@supabase/ssr`
- Create: `webapp/src/lib/supabase/server.ts`
- Create: `webapp/src/lib/supabase/client.ts`
- Create: `webapp/src/lib/supabase/middleware.ts`

**server.ts** — Server-side Supabase client using cookie-based sessions. Uses `createServerClient` from `@supabase/ssr` with Next.js `cookies()` API. Two variants:
- `createClient()` — for Server Components (read-only cookies)
- `createServiceClient()` — for admin operations (service-role key, bypasses RLS)

**client.ts** — Browser-side Supabase client. Singleton `createBrowserClient` from `@supabase/ssr`. Used in Client Components for auth state, realtime, etc.

**middleware.ts** — Helper function for Next.js middleware. Refreshes the Supabase session (exchanges expired tokens) on every request. Exports `updateSession(request)` that returns a `NextResponse` with refreshed cookies.

**Unit tests** — `src/lib/__tests__/supabase.test.ts`:
- `createClient()` returns a valid Supabase client instance
- `createServiceClient()` uses service-role key (not anon key)
- `createBrowserClient()` returns singleton (same instance on repeated calls)
- Middleware `updateSession()` returns a response with set-cookie headers when session is refreshed

---

### Task 4: Next.js Middleware — Session Refresh & Basic Auth

**Files:**
- Create: `webapp/src/middleware.ts`

The middleware is kept **intentionally thin** — it only handles session refresh and basic auth redirect. Subscription guards and admin role checks live in Server Component layouts (`(app)/layout.tsx` and `(admin)/layout.tsx`) to avoid edge-runtime database queries on every request.

The middleware handles:

1. **Session refresh** — Call `updateSession()` to keep auth tokens fresh
2. **Public routes** — Allow access to: `/`, `/login`, `/signup`, `/pricing`, `/auth/*`, `/api/*`, `/_next/*`, static files
3. **Protected routes** — `/chat/*`, `/dashboard/*`, `/settings/*`, `/admin/*` require authenticated user (session exists)
4. **Redirect logic:**
   - Unauthenticated accessing protected route → `/login?redirect={originalPath}`
   - Authenticated accessing `/login` or `/signup` → `/chat`

Subscription guards (redirect to `/pricing` if no active subscription) are handled in `(app)/layout.tsx`. Admin role checks (redirect to `/chat` if not admin) are handled in `(admin)/layout.tsx`. This avoids database queries in edge middleware.

```typescript
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

**Unit tests** — `src/__tests__/unit/middleware-logic.test.ts`:
- Public routes (`/`, `/login`, `/signup`, `/pricing`) pass through without redirect
- `/chat` without auth session → redirects to `/login?redirect=/chat`
- `/admin` without auth session → redirects to `/login?redirect=/admin`
- `/chat` with valid auth session → passes through (no subscription check here)
- Authenticated user accessing `/login` → redirected to `/chat`
- Static files (`/_next/static/*`, `*.svg`) are excluded from matcher
- API routes (`/api/*`) pass through without auth check

**Integration test** — `src/__tests__/integration/middleware.test.ts`:
- Full middleware execution with mocked Supabase session
- Unauthenticated request to `/chat` returns 307 redirect to `/login`
- Authenticated request with expired session refreshes cookies

---

### Task 5: Auth Provider Component

**Files:**
- Create: `webapp/src/components/shared/supabase-provider.tsx`
- Modify: `webapp/src/app/layout.tsx` — wrap children with provider

Client Component that:
- Creates the browser Supabase client
- Listens for `onAuthStateChange` events
- Provides auth context (user, session, loading state) via React Context
- Calls `router.refresh()` on sign-in/sign-out to re-run server components

**Unit test** — `src/components/shared/__tests__/supabase-provider.test.tsx`:
- Renders children while loading (shows loading state)
- Provides user object via context after auth resolves
- Calls `router.refresh()` when auth state changes (SIGNED_IN, SIGNED_OUT)

---

## Phase 2: Auth Pages

### Task 6: Auth Layout

**Files:**
- Create: `webapp/src/app/(auth)/layout.tsx`

Minimal centered layout matching the dark theme:
- Full-height dark background
- Centered card container (max-w-md)
- Magister logo at top
- Back-to-home link

### Task 7: Signup Page

**Files:**
- Create: `webapp/src/app/(auth)/signup/page.tsx`

Server Component with a client form:
- Email + password fields
- "Create account" button
- Link to `/login` for existing users
- Calls `supabase.auth.signUp()` with email confirmation enabled
- On success: shows "Check your email" message
- Error handling: duplicate email, weak password, rate limiting

**Unit tests** — `src/app/(auth)/signup/__tests__/signup.test.tsx`:
- Renders email and password fields
- Submit button is disabled when fields are empty
- Shows validation error for invalid email format
- Shows validation error for password < 8 characters
- Calls `supabase.auth.signUp()` with correct email and password
- Shows success message ("Check your email") after successful signup
- Shows error message for duplicate email
- Shows error message for weak password
- "Already have an account?" link navigates to `/login`

### Task 8: Login Page

**Files:**
- Create: `webapp/src/app/(auth)/login/page.tsx`

Server Component with a client form:
- Email + password fields
- "Sign in" button
- "Forgot password?" link (stretch goal)
- Link to `/signup` for new users
- Calls `supabase.auth.signInWithPassword()`
- On success: redirect to `/chat` (or `redirect` query param)
- Error handling: invalid credentials, unconfirmed email

**Unit tests** — `src/app/(auth)/login/__tests__/login.test.tsx`:
- Renders email and password fields
- Calls `supabase.auth.signInWithPassword()` on submit
- Redirects to `/chat` on successful login
- Redirects to `redirect` query param value when present (e.g., `/dashboard`)
- Shows error message for invalid credentials
- Shows error message for unconfirmed email
- "Don't have an account?" link navigates to `/signup`

### Task 9: Auth Callback Route

**Files:**
- Create: `webapp/src/app/auth/callback/route.ts`

Next.js Route Handler that:
- Extracts `code` from query params (used by both email confirmation and password reset)
- Exchanges code for session via `supabase.auth.exchangeCodeForSession(code)`
- Redirects to `/pricing` (new users) or `/chat` (returning users)
- For password reset: redirects to `/reset-password?type=recovery`
- Handles errors gracefully (expired link, invalid code)

**Unit test** — `src/app/auth/callback/__tests__/route.test.ts`:
- Exchanges valid code for session and redirects
- Returns error response for missing code parameter
- Returns error response for invalid/expired code
- Password reset code redirects to `/reset-password?type=recovery`

### Task 9b: Password Reset Page

**Files:**
- Create: `webapp/src/app/(auth)/reset-password/page.tsx`

Two-mode page:
- **Request mode** (default): Email field + "Send reset link" button
  - Calls `supabase.auth.resetPasswordForEmail(email)`
  - Shows "Check your email" success message
- **Update mode** (`?type=recovery`): New password + confirm password fields
  - Shown after clicking the reset link in email (callback sets recovery session)
  - Calls `supabase.auth.updateUser({ password })`
  - Redirects to `/chat` on success

**Unit tests** — `src/app/(auth)/reset-password/__tests__/reset-password.test.tsx`:
- Request mode: renders email field and send button
- Request mode: calls `resetPasswordForEmail` on submit
- Request mode: shows success message after sending
- Update mode: renders password and confirm password fields
- Update mode: validates passwords match
- Update mode: calls `updateUser` with new password
- Update mode: redirects to `/chat` on success

### Phase 2 Integration Test — `src/__tests__/integration/auth-flow.test.ts`:
- Full signup → check email → confirm → login → redirect flow (mocked Supabase auth)
- Login with valid credentials → redirected to `/chat`
- Login with invalid credentials → stays on login page with error
- Signup with existing email → shows duplicate error
- Auth callback with valid code → session created, redirected appropriately
- Password reset: request → email sent → callback → new password → success

---

## Phase 3: Stripe Checkout & Pricing

### Task 10: Stripe Configuration

**Files:**
- Create: `webapp/src/lib/stripe.ts`

Server-side Stripe client initialization. Exports:
- `stripe` — Stripe client instance
- `PRICES` — price ID mapping: `{ cmo: 'price_xxx', cmo_plus: 'price_yyy' }`

**Stripe Dashboard Setup (manual, not code):**
- Create two Products: "CMO" ($299/mo) and "CMO+" ($999/mo)
- Note the Price IDs for the config
- Configure webhook endpoint: `https://{domain}/api/billing/webhook`
- Add events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

### Task 11: Checkout API Route

**Files:**
- Create: `webapp/src/app/api/stripe/checkout/route.ts`

POST endpoint that:
1. Verifies Supabase JWT (user must be authenticated)
2. Accepts `{ plan: 'cmo' | 'cmo_plus' }` in request body
3. Finds or creates Stripe Customer (using `profiles.stripe_customer_id`)
4. Creates Stripe Checkout Session:
   - `mode: 'subscription'`
   - `line_items: [{ price: PRICES[plan], quantity: 1 }]`
   - `client_reference_id: user.id` (links back to Supabase user)
   - `metadata: { plan }`
   - `success_url: '{origin}/chat?session_id={CHECKOUT_SESSION_ID}'`
   - `cancel_url: '{origin}/pricing'`
   - `customer: stripeCustomerId`
5. Returns `{ url: session.url }` for redirect

**Unit tests** — `src/app/api/stripe/checkout/__tests__/route.test.ts`:
- Returns 401 for unauthenticated request
- Returns 400 for missing or invalid `plan` field
- Creates Stripe Customer if `profiles.stripe_customer_id` is null
- Reuses existing Stripe Customer if already set
- Returns checkout session URL for valid CMO plan
- Returns checkout session URL for valid CMO+ plan
- Sets `client_reference_id` to the authenticated user's ID
- Stores `stripe_customer_id` in profiles after customer creation

### Task 12: Billing Portal API Route

**Files:**
- Create: `webapp/src/app/api/stripe/portal/route.ts`

POST endpoint that:
1. Verifies Supabase JWT
2. Looks up `profiles.stripe_customer_id`
3. Creates Stripe Billing Portal session
4. Returns `{ url: session.url }`

**Unit tests** — `src/app/api/stripe/portal/__tests__/route.test.ts`:
- Returns 401 for unauthenticated request
- Returns 400 if user has no `stripe_customer_id`
- Returns portal session URL for valid customer

### Task 13: Extend Billing Webhook

**Files:**
- Modify: `webapp/src/app/api/billing/webhook/route.ts`

Add handlers for:

- **`customer.subscription.created`** — Insert row into `subscriptions` table
- **`customer.subscription.updated`** — Update subscription status, period dates, plan
- **`customer.subscription.deleted`** — Update status to 'canceled', trigger destroy (existing)
- **`invoice.payment_failed`** — Update subscription status to 'past_due'
- **`checkout.session.completed`** — (existing) Also update `profiles.stripe_customer_id` and insert subscription

All webhook handlers use Supabase service-role client to write directly.

**Unit tests** — `src/__tests__/unit/stripe-webhook.test.ts`:
- Returns 400 for missing `stripe-signature` header
- Returns 400 for invalid signature
- `checkout.session.completed`: creates subscription row, updates profile, triggers provision
- `customer.subscription.created`: inserts subscription with correct plan and status
- `customer.subscription.updated`: updates status and period dates
- `customer.subscription.deleted`: sets status to 'canceled', calls Gateway destroy
- `invoice.payment_failed`: sets subscription status to 'past_due'
- Ignores unknown event types (returns 200 without error)
- Handles missing `client_reference_id` gracefully (no crash)

### Task 14: Pricing Page

**Files:**
- Create: `webapp/src/app/pricing/page.tsx`

Standalone page (accessible without auth) with:
- Two pricing cards matching the landing page design (CMO $299/mo, CMO+ $999/mo)
- Feature comparison list per plan
- "Get Started" buttons that:
  - If not authenticated → redirect to `/signup?plan={plan}`
  - If authenticated but no subscription → POST to `/api/stripe/checkout`
  - If authenticated with subscription → redirect to `/chat`
- FAQ section about billing
- Dark theme matching landing page aesthetic

**Unit tests** — `src/app/pricing/__tests__/pricing.test.tsx`:
- Renders both pricing tiers (CMO and CMO+)
- Displays correct prices ($299/mo and $999/mo)
- "Get Started" button for unauthenticated user links to `/signup?plan=cmo`
- "Get Started" button for authenticated user without subscription calls checkout API

### Phase 3 Integration Test — `src/__tests__/integration/stripe-checkout.test.ts`:
- Authenticated user clicks "Get Started" on pricing → checkout session created → redirect to Stripe
- Webhook: `checkout.session.completed` → subscription row created → provision triggered
- Webhook: `customer.subscription.deleted` → subscription status updated → destroy triggered
- Webhook: `invoice.payment_failed` → subscription marked past_due
- User with active subscription is redirected from pricing page to `/chat`

---

## Phase 4: Chat UI

### Task 15: App Layout (Sidebar Shell)

**Files:**
- Create: `webapp/src/app/(app)/layout.tsx`
- Create: `webapp/src/app/(app)/loading.tsx`
- Create: `webapp/src/components/shared/app-sidebar.tsx`
- Create: `webapp/src/components/shared/user-nav.tsx`

**`layout.tsx`** — includes subscription guard: queries `subscriptions` table for `status = 'active'`. If no active subscription, redirects to `/pricing`. This check lives in the layout (Server Component) rather than middleware to avoid database queries on every edge request.

**`loading.tsx`** — skeleton UI (sidebar placeholder + main content shimmer) shown while Server Components load.

App shell layout with:
- **Left sidebar** (collapsible):
  - Magister logo
  - "New Chat" button
  - Chat session list (most recent first)
  - Bottom: Dashboard link, Settings link
- **Header bar**:
  - Agent status badge (running / suspended / waking)
  - User nav dropdown (avatar, name, settings, sign out)
- **Main content area** — renders child pages

Sidebar uses shadcn `Sheet` on mobile, fixed panel on desktop. Session list loaded via Server Component from `chat_sessions` table.

**Unit tests** — `src/components/shared/__tests__/user-nav.test.tsx`:
- Renders user avatar and display name
- Dropdown opens on click showing: Settings, Sign out
- "Sign out" calls `supabase.auth.signOut()`

**Unit tests** — `src/components/shared/__tests__/app-sidebar.test.tsx`:
- Renders "New Chat" button
- Renders Dashboard and Settings navigation links
- "New Chat" navigates to `/chat`

### Task 16: Gateway API Client

**Files:**
- Create: `webapp/src/lib/gateway.ts`

Client-side utility for communicating with the Gateway:

```typescript
// Chat streaming via SSE
async function* streamChat(
  gatewayUrl: string,
  jwt: string,
  message: string,
  sessionId: string
): AsyncGenerator<ChatEvent>

// Agent status check
async function getAgentStatus(
  gatewayUrl: string,
  jwt: string
): Promise<AgentStatus>

// Types
type ChatEvent =
  | { type: 'chunk'; content: string }
  | { type: 'tool_use'; tool: string; input: object }
  | { type: 'thinking'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'waking' }
```

Uses `fetch` with SSE parsing (not EventSource, for POST support). Handles:
- Connection errors with retry
- Machine wake-up events (show "Waking agent..." state)
- Stream interruption recovery

**Unit tests** — `src/lib/__tests__/gateway.test.ts`:
- `streamChat()` sends POST with correct Authorization header and body
- Parses SSE `chunk` events into `{ type: 'chunk', content: '...' }`
- Parses SSE `tool_use` events with JSON input/output
- Parses SSE `thinking` events
- Yields `{ type: 'done' }` on stream completion
- Yields `{ type: 'error', message }` on stream error event
- Yields `{ type: 'waking' }` when machine is being resumed
- `getAgentStatus()` returns parsed status response
- `getAgentStatus()` handles 404 (no machine) gracefully
- Retries on network failure (fetch throws)
- Does not retry on 401 (auth error)
- Does not retry on 409 (concurrent request)

### Task 17: Chat Message Component

**Files:**
- Create: `webapp/src/components/chat/chat-message.tsx`

Renders a single message with:
- **User messages**: Right-aligned, subtle background, plain text
- **Agent messages**: Left-aligned, full-width, with:
  - Markdown rendering (react-markdown + remark-gfm + rehype-highlight)
  - Code blocks with syntax highlighting and copy button
  - Tool use blocks (collapsible, show tool name + input + output)
  - Thinking/reasoning blocks (collapsible, dimmed text)
  - File/artifact cards (if agent creates files)
- **Timestamps** on hover
- **Copy message** button on hover

**Unit tests** — `src/components/chat/__tests__/chat-message.test.tsx`:
- Renders user message with correct alignment and styling
- Renders agent message with markdown content (headings, lists, links)
- Renders code blocks with syntax highlighting
- Shows copy button on code blocks
- Renders tool use blocks when `toolUses` are present
- Renders thinking section when `thinking` is present
- Thinking section is collapsed by default, expands on click
- Shows timestamp on hover
- Shows copy message button on hover

### Task 18: Tool Use Display

**Files:**
- Create: `webapp/src/components/chat/tool-use-display.tsx`

Renders agent tool executions inline:
- Collapsible panel with tool icon + name
- Input parameters (formatted JSON or natural description)
- Output/result (truncated with expand)
- Status indicator (running spinner, checkmark, error)
- Visual distinction by tool type:
  - Browser: globe icon + URL
  - Shell: terminal icon + command
  - File write: document icon + path
  - Web search: search icon + query

**Unit tests** — `src/components/chat/__tests__/tool-use-display.test.tsx`:
- Renders tool name and icon for browser tool
- Renders tool name and icon for shell tool
- Renders tool name and icon for web search tool
- Shows running spinner when `status = 'running'`
- Shows checkmark when `status = 'complete'`
- Shows error indicator when `status = 'error'`
- Displays input parameters as formatted JSON
- Output is truncated at 500 chars with "Show more" button
- Clicking "Show more" reveals full output
- Panel is collapsed by default

### Task 19: Chat Input Component

**Files:**
- Create: `webapp/src/components/chat/chat-input.tsx`

Message input area:
- Auto-resizing textarea (1-5 rows)
- Send button (disabled while streaming)
- Keyboard shortcut: Enter to send, Shift+Enter for newline
- Disabled state with "Agent is working..." message during streaming

Note: File upload is deferred to V2 — the Gateway's `ChatRequest` model only accepts `message` and `session_id`, with no file upload endpoint.

**Unit tests** — `src/components/chat/__tests__/chat-input.test.tsx`:
- Renders textarea and send button
- Send button is disabled when textarea is empty
- Calls `onSend` with message text when send button clicked
- Calls `onSend` when Enter key pressed
- Does NOT call `onSend` when Shift+Enter pressed (inserts newline)
- Clears textarea after successful send
- Send button and textarea disabled when `isStreaming` prop is true
- Shows "Agent is working..." text when streaming
- Textarea auto-resizes as content grows

### Task 20: Chat Page

**Files:**
- Create: `webapp/src/app/(app)/chat/page.tsx`
- Create: `webapp/src/app/(app)/chat/[sessionId]/page.tsx`

**`/chat`** (no session) — Server Component that:
1. Creates a new `chat_sessions` row in Supabase
2. Redirects to `/chat/[newSessionId]`

**`/chat/[sessionId]`** — Client Component that:
1. Verifies session belongs to current user
2. Maintains local message state: `Message[]`
3. On send:
   a. Add user message to local state
   b. Show thinking indicator
   c. Call `streamChat()` with Gateway URL + JWT + session_id
   d. Parse SSE events:
      - `chunk` → append to current agent message
      - `tool_use` → add tool use block to current message
      - `thinking` → show thinking indicator with content
      - `waking` → show "Waking your agent..." banner
      - `done` → finalize message, re-enable input
      - `error` → show error toast, re-enable input
   e. Update session title (first message → use as title via Supabase update)
4. Auto-scroll to bottom on new content
5. Agent status badge in header (polls `/api/status` every 30s)

**State shape:**
```typescript
type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolUses?: ToolUse[];
  thinking?: string;
  createdAt: Date;
};

type ToolUse = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'running' | 'complete' | 'error';
};
```

### Task 21: Chat Sidebar

**Files:**
- Create: `webapp/src/components/chat/chat-sidebar.tsx`

Session list in the sidebar:
- Loaded from `chat_sessions` table (Server Component)
- Ordered by `updated_at DESC`
- Each item shows: title (truncated), relative time
- Active session highlighted
- Click to navigate to `/chat/[sessionId]`
- Delete session (with confirmation)
- "New Chat" button at top

**Unit tests** — `src/components/chat/__tests__/chat-sidebar.test.tsx`:
- Renders list of sessions ordered by most recent
- Truncates long session titles
- Highlights the active session
- "New Chat" button navigates to `/chat`
- Delete button shows confirmation dialog
- Confirming delete removes session from list
- Empty state shows "No conversations yet" message

### Task 22: Agent Status Badge

**Files:**
- Create: `webapp/src/components/chat/agent-status-badge.tsx`

Small status indicator shown in the app header:
- **Running** — green dot + "Agent ready"
- **Suspended** — yellow dot + "Agent sleeping"
- **Waking** — pulsing yellow dot + "Waking up..."
- **Provisioning** — spinner + "Setting up..."
- **Failed** — red dot + "Agent offline"
- Polls Gateway `/api/status` every 30 seconds
- Click to see detailed status (machine region, uptime, LLM spend)

**Unit tests** — `src/components/chat/__tests__/agent-status-badge.test.tsx`:
- Shows green dot and "Agent ready" for running status
- Shows yellow dot and "Agent sleeping" for suspended status
- Shows pulsing animation for waking status
- Shows spinner for provisioning status
- Shows red dot for failed status
- Clicking badge toggles detail popover
- Detail popover shows region, uptime, and LLM spend

### Phase 4 Integration Test — `src/__tests__/integration/chat-session.test.ts`:
- User sends message → message appears in chat → SSE stream starts → agent response renders incrementally
- Tool use events render inline tool display with running→complete status transition
- Thinking events show collapsible thinking section
- Waking event shows "Waking your agent..." banner that disappears when stream starts
- Error event shows toast and re-enables input
- First message updates session title in sidebar
- Creating new chat → new session created in DB → redirected to `/chat/[id]`
- Switching sessions via sidebar → URL changes → messages cleared for new session
- Concurrent request (409) → shows "agent is still working" error message

---

## Phase 5: User Dashboard

### Task 23: Dashboard Page

**Files:**
- Create: `webapp/src/app/(app)/dashboard/page.tsx`

Server Component showing:
- **Agent status card** — current status, region, last active time
- **Usage this month** — LLM spend ($ and % of budget), requests count
- **Plan card** — current plan, renewal date, "Manage billing" button (→ Stripe portal)
- **Quick actions** — "Start chatting" button, "View pricing" if no subscription

Data sources (all via Supabase server client):
- `user_machines` — agent status, region, last_activity
- `usage_events` — monthly spend aggregation
- `subscriptions` — plan info, period dates
- `profiles` — user info

**Unit tests** — `src/app/(app)/dashboard/__tests__/dashboard.test.tsx`:
- Renders agent status card with correct status (running/suspended)
- Shows LLM spend as dollar amount and percentage of budget
- Shows correct plan name and renewal date
- "Manage billing" button calls billing portal API
- "Start chatting" button navigates to `/chat`
- Shows "View pricing" instead when no subscription
- Handles missing machine data gracefully (shows "No agent" state)

### Task 24: Settings Page

**Files:**
- Create: `webapp/src/app/(app)/settings/page.tsx`

Account settings:
- **Profile** — display name, email (read-only)
- **Password** — change password form
- **Billing** — current plan, "Manage billing" button (→ Stripe portal)
- **Danger zone** — "Delete account" (with confirmation, triggers teardown)

**Unit tests** — `src/app/(app)/settings/__tests__/settings.test.tsx`:
- Renders display name and email fields
- Email field is read-only
- Updating display name calls `supabase.from('profiles').update()`
- Password change form validates new password requirements
- "Manage billing" button calls billing portal API
- "Delete account" shows confirmation dialog
- Confirming deletion calls teardown flow

---

## Phase 6: Admin Dashboard

### Task 25: Admin Layout, Auth Guard & Machine Control API Route

**Files:**
- Create: `webapp/src/app/(admin)/layout.tsx`
- Create: `webapp/src/app/(admin)/loading.tsx`
- Create: `webapp/src/app/api/admin/machines/route.ts`

**Layout** that:
- Checks `profiles.role = 'admin'` via Server Component (using service-role Supabase client)
- Redirects non-admins to `/chat`
- Shows admin-specific navigation: Overview, Users
- Same dark theme as app layout

**Loading** — skeleton UI while admin data loads.

**Machine control API route** (`/api/admin/machines`):
POST endpoint that proxies machine control actions to the Gateway:
1. Verifies Supabase JWT (user must be authenticated)
2. Verifies `profiles.role = 'admin'` (using service-role client)
3. Accepts `{ action: 'restart' | 'suspend', user_id: string }`
4. Calls Gateway `/api/provision` (restart) or `/api/destroy` (suspend) with `GATEWAY_API_KEY`
5. Returns the Gateway response

This keeps `GATEWAY_API_KEY` server-side — admin Client Components never see it.

**Unit test** — `src/app/api/admin/machines/__tests__/route.test.ts`:
- Returns 401 for unauthenticated request
- Returns 403 for non-admin user
- Proxies restart action to Gateway `/api/provision`
- Proxies suspend action to Gateway `/api/destroy`
- Returns 400 for invalid action

### Task 26: Admin Overview Page

**Files:**
- Create: `webapp/src/app/(admin)/admin/page.tsx`

Server Component with aggregate stats:
- **Total users** — count of `profiles`
- **Active agents** — count of `user_machines` where status = 'running'
- **Total LLM spend this month** — sum of `usage_events.cost_cents` this month
- **Revenue** — count of `subscriptions` where status = 'active' × plan price
- **Recent activity** — last 10 usage events (user, model, cost, time)
- **Machine status breakdown** — pie/bar chart of running/suspended/failed counts

Data source: Supabase service-role client (bypasses RLS to see all users).

**Unit tests** — `src/app/(admin)/admin/__tests__/overview.test.tsx`:
- Renders total user count
- Renders active agent count
- Renders total LLM spend formatted as dollars
- Renders estimated revenue based on active subscriptions
- Renders recent activity table with correct columns
- Shows machine status breakdown counts
- Handles empty data gracefully (0 users, 0 agents)

### Task 27: Admin Users Page

**Files:**
- Create: `webapp/src/app/(admin)/admin/users/page.tsx`
- Create: `webapp/src/components/admin/users-table.tsx`
- Create: `webapp/src/components/admin/machine-controls.tsx`

**Users table** with columns:
| Email | Plan | Agent Status | LLM Spend | Budget | Last Active | Actions |
|---|---|---|---|---|---|---|
| user@co.com | CMO | Running | $12.34 | $50/mo | 2 min ago | Restart \| Suspend |

Features:
- Sortable by any column
- Filterable by status and plan
- Search by email
- Expandable rows showing detailed usage
- **Machine controls**:
  - Restart button → calls `/api/admin/machines` (Next.js API route) → proxies to Gateway `/api/provision`
  - Suspend button → calls `/api/admin/machines` (Next.js API route) → proxies to Gateway `/api/destroy`
  - The Next.js API route holds `GATEWAY_API_KEY` server-side (never exposed to browser)
  - API route verifies admin role before proxying

Data sources:
- `profiles` — email, role
- `user_machines` — status, region, last_activity, plan
- `usage_events` — monthly spend per user
- `subscriptions` — plan, status

**Unit tests** — `src/components/admin/__tests__/users-table.test.tsx`:
- Renders all users with correct columns
- Sorts by email ascending/descending on column header click
- Sorts by LLM spend ascending/descending
- Filters by agent status (running, suspended, failed)
- Filters by plan (cmo, cmo_plus)
- Search by email filters table rows
- Empty search shows all users
- No matching results shows "No users found" message

**Unit tests** — `src/components/admin/__tests__/machine-controls.test.tsx`:
- Renders "Restart" button for non-running machines
- Renders "Suspend" button for running machines
- Restart button shows confirmation dialog
- Suspend button shows confirmation dialog
- Confirming restart calls Gateway provision endpoint with correct API key
- Confirming suspend calls Gateway destroy endpoint with correct API key
- Shows success toast after successful action
- Shows error toast on failed action
- Buttons disabled while action is pending

### Phase 6 Integration Test — `src/__tests__/integration/admin-access.test.ts`:
- Non-admin user accessing `/admin` → redirected to `/chat`
- Admin user accessing `/admin` → page renders with aggregate data
- Admin users table loads all users from Supabase (not just own)
- Admin machine controls: restart calls Gateway and updates table status
- Admin machine controls: suspend calls Gateway and updates table status

---

## Phase 7: Polish & Integration

### Task 28: Update Landing Page CTAs

**Files:**
- Modify: `webapp/src/app/page.tsx`

Update call-to-action buttons:
- Hero "Get Started" → `/signup`
- Pricing "Get Started" buttons → `/signup?plan=cmo` or `/signup?plan=cmo_plus`
- Keep existing waitlist flow as a fallback (show waitlist if user is not logged in and product is in beta)
- Add "Sign In" link to nav bar (top right)

---

## Implementation Order

| Phase | Tasks | Description | Depends On |
|---|---|---|---|
| 1. Auth Foundation | 0-5 | Dependencies, test setup, migration, Supabase clients, middleware, provider | — |
| 2. Auth Pages | 6-9b | Layout, signup, login, callback, password reset | Phase 1 |
| 3. Stripe | 10-14 | Config, checkout, portal, webhook, pricing page | Phase 2 |
| 4. Chat UI | 15-22 | App shell, gateway client, chat components, pages | Phase 2, 3 |
| 5. User Dashboard | 23-24 | Dashboard, settings pages | Phase 3, 4 |
| 6. Admin Dashboard | 25-27 | Admin layout + API route, overview, users table | Phase 1 |
| 7. Polish | 28 | CTA updates on landing page | All |

**Phases 4 and 6 can be parallelized** — the admin dashboard only depends on Phase 1 (auth + database), not on the chat UI.

**Phase 5 depends on Phase 3** (Stripe) because the dashboard shows subscription/billing data.

**Estimated total: ~32 tasks, ~60-80 implementation steps**

### Test Execution

Run all tests at any point during development:
```bash
cd webapp && pnpm test              # Run all tests
cd webapp && pnpm test --watch      # Watch mode during development
cd webapp && pnpm test --coverage   # With coverage report
```

Tests should be written **before or alongside** each task's implementation. Each phase's integration tests serve as acceptance criteria — the phase is complete when all its integration tests pass.

---

## Gateway Changes Needed

The existing Gateway endpoints should be sufficient for all features. However, verify these endpoints work as expected:

| Endpoint | Used By | Exists? |
|---|---|---|
| POST /api/chat | Chat UI | Yes |
| GET /api/status | Agent status badge, dashboard | Yes |
| POST /api/provision | Stripe webhook | Yes |
| POST /api/destroy | Admin controls, subscription cancel | Yes |
| GET /health | Health checks | Yes |
| POST /llm/v1/chat/completions | OpenClaw machines (not webapp) | Yes |

**No new Gateway endpoints required.** Admin reads use direct Supabase queries. Admin machine controls use existing provision/destroy with the API key.

---

## Open Questions

1. **Email confirmation flow** — Should we require email verification before allowing access? Supabase supports this natively but it adds friction. For launch, consider allowing access immediately and prompting for confirmation later.

2. **Free trial** — Should users get a limited free trial before subscribing? This would change the signup→pricing→checkout flow. For V1, require payment upfront.

3. **Message persistence** — Currently messages are kept in local state only (OpenClaw stores them on the volume). Should we mirror messages to Supabase for cross-device access and history? This adds complexity but improves UX. Consider for V2.

4. **Admin machine restart** — The current Gateway `/api/provision` is idempotent but creates new infrastructure if none exists. For admin "restart," we may need a separate endpoint that just stops and starts the existing machine without reprovisioning. Alternatively, use the Fly API directly from the admin page.

5. **Onboarding flow** — After first payment, the agent takes 10-15 seconds to provision. Should we show a guided onboarding (explain what the agent can do) during this wait, or just a loading spinner?

6. **Session title generation** — Should the first user message become the session title, or should we use an LLM to generate a summary title (like ChatGPT does)? For V1, use first message truncated to 50 chars.

7. **Real-time agent status** — The current approach polls `/api/status` every 30s. Should we use Supabase Realtime to subscribe to `user_machines` changes for instant status updates? Lower priority but better UX. Consider polling only when the tab is active (using `document.visibilityState`).

8. **Webhook idempotency** — Stripe may deliver the same event multiple times. The webhook handler should check for duplicate `stripe_subscription_id` before inserting into `subscriptions`, and handle `checkout.session.completed` idempotently (check if subscription already exists).

9. **Admin user creation** — How are admin users created? Document the procedure (e.g., manual SQL update: `UPDATE profiles SET role = 'admin' WHERE email = '...'`).

10. **Empty session UX** — When a user clicks a previous session in the sidebar, messages are only in local state (not persisted). The UI should show a clear message like "Previous conversation history is stored on your agent" rather than an empty chat. Consider adding simple message persistence to Supabase in V2.

11. **`react-markdown` bundle size** — The markdown rendering packages add ~100-200KB to the client bundle. Use `next/dynamic` to lazy-load them only on the chat page.

12. **`usage_events` FK and account deletion** — The `usage_events` table references `auth.users(id)` without `ON DELETE CASCADE`. When a user deletes their account, `usage_events` rows will become orphaned (FK violation or blocked delete). Decide: cascade delete, set null, or keep for billing history.

---

## Review Notes

This plan was reviewed as a principal software engineer. Key changes made during review:

1. **Fixed critical RLS vulnerability** — The `profiles` UPDATE policy originally allowed any user to set `role = 'admin'`. Fixed by adding a `WITH CHECK` that prevents role column changes by non-service-role clients.

2. **Fixed migration function name** — Changed `update_updated_at()` to `handle_updated_at()` to match the existing function defined in migration `20260216000001`.

3. **Moved dependency/env setup to Phase 1** (Task 0) — shadcn components and env vars are prerequisites, not Phase 7 polish.

4. **Simplified middleware** — Moved subscription and admin role checks from edge middleware to Server Component layouts. Middleware now only handles session refresh and basic auth redirect. This avoids database queries in edge runtime on every request.

5. **Added admin API route** — Machine control actions (restart/suspend) now proxy through `/api/admin/machines` server-side route to keep `GATEWAY_API_KEY` out of the browser.

6. **Promoted password reset** — Added as a required feature (Task 9b) instead of a stretch goal. Users paying $299/mo must be able to recover access.

7. **Removed file upload from chat input** — The Gateway's `ChatRequest` model only accepts `message` and `session_id`. No file upload backend exists. Deferred to V2.

8. **Consolidated auth callback** — Single route at `app/auth/callback/route.ts` handles both email confirmation and password reset callbacks.

9. **Added loading states** — `loading.tsx` files for `(app)` and `(admin)` layouts to show skeleton UI during Server Component loading.

10. **Added Phase 5 → Phase 3 dependency** — User dashboard depends on Stripe (Phase 3) for billing data display.
