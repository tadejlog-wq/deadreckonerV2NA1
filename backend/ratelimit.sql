-- ============================================================
-- Deadreckoner — rate limiting store + atomic consume function.
-- Run once in Supabase SQL Editor.
-- ============================================================
create table if not exists public.rate_limits (
  key text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;
-- No policies: only service_role (Edge Functions) may touch this table.

create or replace function public.consume_rate_limit(
  p_key text, p_max integer, p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer; v_start timestamptz;
begin
  insert into public.rate_limits(key, count, window_start)
  values (p_key, 0, now())
  on conflict (key) do nothing;

  select count, window_start into v_count, v_start
  from public.rate_limits where key = p_key for update;

  if now() - v_start > make_interval(secs => p_window_seconds) then
    update public.rate_limits set count = 1, window_start = now() where key = p_key;
    return true;
  end if;

  if v_count >= p_max then
    return false;
  end if;

  update public.rate_limits set count = count + 1 where key = p_key;
  return true;
end;
$$;

revoke all on function public.consume_rate_limit(text,integer,integer) from public, anon, authenticated;
