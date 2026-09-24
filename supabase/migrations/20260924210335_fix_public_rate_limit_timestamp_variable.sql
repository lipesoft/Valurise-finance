-- Fix a reserved PostgreSQL identifier shadowing the timestamp variable.
-- The old `current_time` reference resolved to the SQL CURRENT_TIME value
-- (time with time zone), which made every rate-limit RPC fail before reaching
-- protected endpoints such as the personal AI chat.
create or replace function public.consume_public_rate_limit(
  p_key text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_hits integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_key is null or char_length(p_key) <> 64
     or p_max_attempts not between 1 and 50
     or p_window_seconds not between 60 and 86400 then
    raise exception 'invalid rate-limit parameters';
  end if;

  insert into public.public_rate_limits (bucket_key, hits, window_started_at, expires_at)
  values (p_key, 1, v_now, v_now + make_interval(secs => p_window_seconds))
  on conflict (bucket_key) do update
  set hits = case
        when public.public_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then 1
        else public.public_rate_limits.hits + 1
      end,
      window_started_at = case
        when public.public_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then v_now
        else public.public_rate_limits.window_started_at
      end,
      expires_at = v_now + make_interval(secs => p_window_seconds)
  returning hits into v_current_hits;

  if random() < 0.02 then
    delete from public.public_rate_limits where expires_at < v_now;
  end if;

  return v_current_hits <= p_max_attempts;
end;
$$;

-- Keep the SECURITY DEFINER RPC restricted to server-side service-role calls.
revoke all on function public.consume_public_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_public_rate_limit(text, integer, integer) to service_role;
