create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  roles jsonb not null default '[]',
  experience jsonb not null default '[]',
  ai_providers jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- Prevent duplicate emails
create unique index waitlist_email_idx on public.waitlist (email);

-- RLS: anonymous users can only insert
alter table public.waitlist enable row level security;

create policy "Allow anonymous inserts"
  on public.waitlist for insert
  to anon with check (true);
