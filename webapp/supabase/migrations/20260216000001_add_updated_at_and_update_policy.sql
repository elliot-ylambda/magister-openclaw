alter table public.waitlist
  add column updated_at timestamptz not null default now();

create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger waitlist_updated_at
  before update on public.waitlist
  for each row execute function public.handle_updated_at();
