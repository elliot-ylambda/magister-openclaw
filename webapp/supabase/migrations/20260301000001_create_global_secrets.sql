-- Global secrets managed by admin, injected into all user machines as Fly secrets.
-- Per-user overrides allow customizing a secret for a specific user.

create table public.global_secrets (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  description text not null default '',
  category text not null default 'general',
  is_sensitive boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger global_secrets_updated_at
  before update on public.global_secrets
  for each row execute function public.handle_updated_at();

alter table public.global_secrets enable row level security;
-- No RLS policies: only service-role key can access.

create table public.user_secret_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  secret_key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, secret_key)
);

create index idx_user_secret_overrides_user_id on public.user_secret_overrides(user_id);

create trigger user_secret_overrides_updated_at
  before update on public.user_secret_overrides
  for each row execute function public.handle_updated_at();

alter table public.user_secret_overrides enable row level security;
-- No RLS policies: only service-role key can access.
