create table if not exists public.rate_limit_buckets (
  scope text not null,
  bucket_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope, bucket_key)
);
alter table public.rate_limit_buckets enable row level security;

create or replace function public.check_rate_limit(
  p_scope text,
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_row public.rate_limit_buckets%rowtype;
begin
  if p_scope is null or length(p_scope) not between 1 and 80
     or p_bucket_key is null or length(p_bucket_key) <> 64
     or p_limit not between 1 and 1000
     or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid_rate_limit_input' using errcode='P0001';
  end if;
  insert into public.rate_limit_buckets(scope,bucket_key,window_started_at,request_count,updated_at)
  values(p_scope,p_bucket_key,v_now,1,v_now)
  on conflict(scope,bucket_key) do update set
    window_started_at = case when public.rate_limit_buckets.window_started_at <= v_now - make_interval(secs => p_window_seconds) then v_now else public.rate_limit_buckets.window_started_at end,
    request_count = case when public.rate_limit_buckets.window_started_at <= v_now - make_interval(secs => p_window_seconds) then 1 else public.rate_limit_buckets.request_count + 1 end,
    updated_at = v_now
  returning * into v_row;
  return jsonb_build_object(
    'allowed', v_row.request_count <= p_limit,
    'retryAfter', greatest(1, ceil(extract(epoch from (v_row.window_started_at + make_interval(secs => p_window_seconds) - v_now))))::integer
  );
end;
$$;

revoke all on table public.rate_limit_buckets from public, anon, authenticated;
grant all on table public.rate_limit_buckets to service_role;
revoke all on function public.check_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text,text,integer,integer) to service_role;
