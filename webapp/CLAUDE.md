# Webapp CLAUDE.md

See root `../CLAUDE.md` for full architecture, commands, and project overview.

This file covers webapp-specific development patterns.

## Quick Commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` (or `make webapp-install` from root) |
| Dev server | `make webapp-dev` from root (port 3020 + Stripe webhook listener) |
| Build | `pnpm build` |
| Lint | `pnpm lint` |
| Run all tests | `pnpm test:run` |
| Run single test | `pnpm vitest run path/to/file.test.ts` |

## Stack

- **Next.js 16** / React 19 / TypeScript / App Router
- **Tailwind CSS v4** (PostCSS plugin — no `tailwind.config.js`)
- **shadcn/ui** (new-york style, Lucide icons) — components in `src/components/ui/`
- **Supabase** for auth + DB (`@supabase/ssr` for SSR cookie handling)
- **Stripe** for billing (checkout, portal, webhooks)
- **Vitest** + Testing Library for tests
- **Resend** for transactional email
- Package manager: **pnpm**
- Path alias: `@/*` → `./src/*`

## Route Groups

- `(app)/` — authenticated app (chat, dashboard, settings, files) with sidebar layout
- `(admin)/` — admin panel (machines, secrets, users)
- `(auth)/` — login, signup, reset-password
- `/` root — public marketing landing page (~2000 lines, self-contained)
- `api/` — API routes (Stripe, Slack, billing webhooks, admin, machine control)

## Key Patterns

- **Supabase clients**: browser client (`lib/supabase/client.ts`), server client (`lib/supabase/server.ts`), middleware (`lib/supabase/middleware.ts`)
- **Auth**: `src/lib/auth.ts` has `getUser` / `requireAuth` helpers; middleware in `src/middleware.ts` handles route protection
- **Gateway communication**: `src/lib/gateway.ts` — SSE streaming, agent status/control
- **Landing page**: single client component in `src/app/page.tsx` with inline section components, Framer Motion animations, and waitlist survey flow
- **Styling**: dark theme only, mix of Tailwind classes and inline `style={{}}` with `rgba()` opacity values

## Testing

- Tests live alongside code in `__tests__/` directories or in `src/__tests__/`
- Mock setup in `src/__tests__/mocks/` (MSW handlers, Supabase mock)
- Test setup file: `src/__tests__/setup.ts`
- Config: `vitest.config.ts`

## Database

Migrations in `supabase/migrations/`. Seed data in `supabase/seed.sql` (dev only, runs on `supabase db reset --local`).
