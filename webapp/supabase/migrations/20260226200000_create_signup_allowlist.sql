-- Gated signups: only emails in this table may register.
-- RLS enabled with NO policies — only the service role can read/write.

create table public.signup_allowlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  notes text,
  created_at timestamptz not null default now()
);

create unique index signup_allowlist_email_idx on public.signup_allowlist (lower(email));

alter table public.signup_allowlist enable row level security;
