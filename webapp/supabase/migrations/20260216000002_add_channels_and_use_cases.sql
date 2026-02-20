alter table public.waitlist
  add column channels jsonb not null default '[]',
  add column use_cases jsonb not null default '[]';
