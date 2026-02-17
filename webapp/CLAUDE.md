# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Marketing landing page for **Magister Marketing** — an autonomous AI marketing agent product. This is a single-page Next.js webapp (no routing beyond `/`) with an email waitlist + multi-step follow-up survey popup. Waitlist and survey data are persisted to Supabase.

## Commands

| Task | Command |
|------|---------|
| Install dependencies | `make install` (uses pnpm) |
| Dev server | `make dev` (runs on port 3020) |
| Build | `make build` |
| Lint | `make lint` |
| Start local Supabase | `make supabase-start-local` |
| Run migrations on local DB | `make supabase-migrate-local` |
| Reset local DB | `make supabase-reset-local` |
| Connect to local DB (psql) | `make connect-local-db` |

Package manager is **pnpm** (not npm/yarn).

## Tech Stack

- **Next.js 16** with React 19, TypeScript, App Router
- **Tailwind CSS v4** (PostCSS plugin, not the old `tailwind.config.js` approach)
- **shadcn/ui** (new-york style, RSC-enabled, Lucide icons) — components in `src/components/ui/`
- **Supabase** (`@supabase/supabase-js`) for database — local dev via `supabase` CLI, migrations in `supabase/migrations/`
- **Framer Motion** (`motion/react`) for scroll-triggered animations
- **Fonts**: Instrument Serif (headings), DM Sans (body), Geist Sans (system)
- Path alias: `@/*` maps to `./src/*`

## Architecture

### Single-Page Structure

The entire site is a single client component in `src/app/page.tsx` (~2000 lines). It contains:
- All section components (Nav, Hero, Problem, HowItWorks, Demo, Skills, Personas, Comparison, Pricing, About, FAQ, CTA, Footer)
- All static data arrays (skills, steps, personas, comparison rows, FAQ items, pricing plans, chat script, survey options)
- The `SurveyPopup` modal (4-step form triggered by email submission)
- Animation helpers (`FadeUp` wrapper using `useInView`)
- `EmailForm` component reused in Hero and CTA sections

### Orphaned Components

`src/components/hero.tsx`, `src/components/waitlist.tsx`, `src/components/glow.tsx`, and `src/components/section-label.tsx` are from a previous design iteration and are **not imported anywhere**. The current page defines its own inline versions.

### Styling Approach

- Dark theme only (black background, white text)
- Most styling uses inline `style={{}}` with `rgba(255,255,255,X)` opacity values and explicit `fontFamily: "var(--font-*)"` references
- Tailwind classes used alongside inline styles
- CSS variables for shadcn/ui theming defined in `src/app/globals.css`
- No separate dark/light mode toggle — the site is permanently dark

### Key Patterns

- **Scroll animations**: `FadeUp` component wraps sections with `motion.div` + `useInView({ once: true })`
- **Nav scroll effect**: Background opacity and blur increase on scroll via `useScroll`/`useTransform`
- **Demo chat**: Auto-playing animated chat simulation triggered by `useInView`, loops with typing indicators
- **Survey flow**: Email entry → `insertWaitlistEmail` → popup modal with 4 steps (role, experience, AI providers + channels, use cases) → each step calls `updateWaitlistSurvey` to persist answers

### Supabase / Database

- **Server actions**: `src/app/actions.ts` — two functions using the service-role client (server-side only):
  - `insertWaitlistEmail(email)` — inserts into `waitlist` table (handles duplicate via unique index)
  - `updateWaitlistSurvey(email, data)` — updates survey columns (roles, experience, ai_providers, channels, use_cases)
- **`waitlist` table** columns: `id` (uuid PK), `email` (unique), `roles`, `experience`, `ai_providers`, `channels`, `use_cases` (all jsonb arrays), `created_at`, `updated_at` (auto-trigger)
- **RLS**: Enabled with anon insert policy only; updates use service-role key to bypass RLS
- **Migrations** in `supabase/migrations/` — run with `make supabase-migrate-local`
- **Local Supabase** config in `supabase/config.toml` (project_id: `webapp`, DB port: 54322, Studio port: 54323)

## Environment

- `.env.local` / `.env.example`:
  - `NEXT_PUBLIC_APP_URL` — app URL (default `http://localhost:3020`)
  - `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL (local: `http://127.0.0.1:54321`)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key
  - `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key (server-side only, used in `actions.ts`)
