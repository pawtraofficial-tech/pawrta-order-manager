-- Additive 72-hour artwork review workflow. Existing previews remain inactive.
-- A new upload or explicit admin restart is required to create a review window.

alter table public.previews
  add column if not exists review_started_at timestamptz,
  add column if not exists review_deadline_at timestamptz,
  add column if not exists review_closed_at timestamptz,
  add column if not exists review_expired_at timestamptz,
  add column if not exists review_sequence integer not null default 1;

alter table public.orders
  add column if not exists approval_source text,
  add column if not exists last_external_warning text;

do $$ begin
  alter table public.orders add constraint orders_approval_source_check
    check (approval_source is null or approval_source in ('manual', 'automatic_72h'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.previews add constraint previews_review_window_check check (
    (review_started_at is null and review_deadline_at is null)
    or (review_started_at is not null and review_deadline_at = review_started_at + interval '72 hours')
  );
exception when duplicate_object then null; end $$;

create index if not exists previews_active_deadline_idx
  on public.previews (review_deadline_at, order_id)
  where review_deadline_at is not null and review_closed_at is null;
create index if not exists orders_approved_preview_id_idx on public.orders (approved_preview_id);
create index if not exists revision_requests_preview_id_idx on public.revision_requests (preview_id);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  preview_id uuid not null references public.previews(id) on delete cascade,
  kind text not null check (kind in ('preview_ready', 'revision_ready', 'reminder_24h', 'reminder_6h', 'automatic_approval')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  review_sequence integer not null default 1,
  unique (preview_id, kind, review_sequence)
);
create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (available_at, created_at)
  where status in ('pending', 'failed');
alter table public.notification_deliveries enable row level security;

create or replace function public.record_preview_upload(
  p_order_id uuid,
  p_storage_path text,
  p_mime_type text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_revision public.revision_requests%rowtype;
  v_version integer;
  v_preview_id uuid;
  v_now timestamptz := statement_timestamp();
  v_deadline timestamptz := statement_timestamp() + interval '72 hours';
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then raise exception 'order_locked' using errcode = 'P0001'; end if;
  if p_storage_path is null or length(p_storage_path) > 500 or p_storage_path not like p_order_id::text || '/%' then
    raise exception 'invalid_storage_path' using errcode = 'P0001';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'invalid_mime_type' using errcode = 'P0001'; end if;

  select coalesce(max(version_number), 0) into v_version from public.previews where order_id = p_order_id;
  if v_version >= 4 then raise exception 'revision_limit_reached' using errcode = 'P0001'; end if;
  if v_version = 0 then
    if v_order.status <> 'artwork_in_progress' then raise exception 'invalid_preview_state' using errcode = 'P0001'; end if;
  else
    if v_order.status <> 'revision_requested' then raise exception 'revision_not_requested' using errcode = 'P0001'; end if;
    select * into v_revision from public.revision_requests
      where order_id = p_order_id and status = 'open' order by created_at desc limit 1 for update;
    if not found then raise exception 'open_revision_not_found' using errcode = 'P0001'; end if;
  end if;

  v_version := v_version + 1;
  insert into public.previews
    (order_id, version_number, storage_path, label, review_started_at, review_deadline_at)
  values
    (p_order_id, v_version, p_storage_path,
     case when v_version = 1 then 'Initial Design' else 'Revision ' || (v_version - 1)::text end,
     v_now, v_deadline)
  returning id into v_preview_id;

  if v_revision.id is not null then
    update public.revision_requests set status = 'completed', completed_at = v_now
      where id = v_revision.id and status = 'open';
    if not found then raise exception 'revision_completion_failed' using errcode = 'P0001'; end if;
    insert into public.audit_events (order_id, event_type, event_data) values
      (p_order_id, 'revision_completed', jsonb_build_object('revisionId', v_revision.id, 'previewId', v_preview_id));
  end if;

  update public.orders set status = 'preview_ready', approval_source = null,
    last_external_warning = null, updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data) values
    (p_order_id, 'preview_uploaded', jsonb_build_object('previewId', v_preview_id, 'version', v_version)),
    (p_order_id, 'review_window_started', jsonb_build_object('previewId', v_preview_id, 'version', v_version, 'deadline', v_deadline));
  insert into public.notification_deliveries (order_id, preview_id, kind)
    values (p_order_id, v_preview_id, case when v_version = 1 then 'preview_ready' else 'revision_ready' end)
    on conflict (preview_id, kind, review_sequence) do nothing;

  return jsonb_build_object('previewId', v_preview_id, 'versionNumber', v_version,
    'revisionId', v_revision.id, 'revised', v_revision.id is not null,
    'reviewStartedAt', v_now, 'reviewDeadlineAt', v_deadline);
end;
$$;

create or replace function public.request_artwork_revision(
  p_order_id uuid, p_preview_id uuid, p_message text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_latest_preview public.previews%rowtype;
  v_revision_id uuid;
  v_count integer;
  v_now timestamptz := statement_timestamp();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then raise exception 'order_locked' using errcode = 'P0001'; end if;
  if v_order.status <> 'preview_ready' then raise exception 'invalid_revision_state' using errcode = 'P0001'; end if;
  if char_length(trim(p_message)) not between 5 and 2000 then raise exception 'invalid_revision_message' using errcode = 'P0001'; end if;
  if exists (select 1 from public.revision_requests where order_id = p_order_id and status = 'open') then
    raise exception 'open_revision_exists' using errcode = 'P0001';
  end if;
  select * into v_latest_preview from public.previews where order_id = p_order_id
    order by version_number desc limit 1 for update;
  if v_latest_preview.id is null or v_latest_preview.id <> p_preview_id then raise exception 'preview_not_latest' using errcode = 'P0001'; end if;
  if v_latest_preview.review_closed_at is not null then raise exception 'review_window_closed' using errcode = 'P0001'; end if;
  if v_latest_preview.review_deadline_at is null or v_latest_preview.review_deadline_at <= v_now then raise exception 'review_window_expired' using errcode = 'P0001'; end if;

  select count(*)::integer into v_count from public.revision_requests where order_id = p_order_id;
  if v_count >= 3 then raise exception 'revision_limit_reached' using errcode = 'P0001'; end if;
  insert into public.revision_requests (order_id, preview_id, message)
    values (p_order_id, p_preview_id, trim(p_message)) returning id into v_revision_id;
  update public.previews set review_closed_at = v_now where id = p_preview_id and review_closed_at is null;
  update public.orders set status = 'revision_requested', revision_count = v_count + 1, updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data) values
    (p_order_id, 'revision_requested', jsonb_build_object('revisionId', v_revision_id, 'previewId', p_preview_id, 'revisionCount', v_count + 1));
  return jsonb_build_object('revisionId', v_revision_id, 'revisionCount', v_count + 1, 'reviewClosedAt', v_now);
end;
$$;

create or replace function public.approve_artwork(
  p_order_id uuid, p_preview_id uuid
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_latest_preview public.previews%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then
    return jsonb_build_object('changed', false, 'previewId', v_order.approved_preview_id,
      'approvedAt', v_order.approved_at, 'approvalSource', v_order.approval_source);
  end if;
  if v_order.status <> 'preview_ready' then raise exception 'invalid_approval_state' using errcode = 'P0001'; end if;
  if exists (select 1 from public.revision_requests where order_id = p_order_id and status = 'open') then raise exception 'open_revision_exists' using errcode = 'P0001'; end if;
  select * into v_latest_preview from public.previews where order_id = p_order_id
    order by version_number desc limit 1 for update;
  if v_latest_preview.id is null or v_latest_preview.id <> p_preview_id then raise exception 'preview_not_latest' using errcode = 'P0001'; end if;
  if v_latest_preview.review_closed_at is not null then raise exception 'review_window_closed' using errcode = 'P0001'; end if;
  if v_latest_preview.review_deadline_at is null or v_latest_preview.review_deadline_at <= v_now then raise exception 'review_window_expired' using errcode = 'P0001'; end if;

  update public.previews set review_closed_at = v_now where id = p_preview_id;
  update public.orders set status = 'approved', approved_preview_id = p_preview_id,
    approved_at = v_now, approval_source = 'manual', production_ready = true, updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data)
    values (p_order_id, 'artwork_approved', jsonb_build_object('previewId', p_preview_id, 'source', 'manual'));
  return jsonb_build_object('changed', true, 'previewId', p_preview_id,
    'storagePath', v_latest_preview.storage_path, 'approvedAt', v_now, 'approvalSource', 'manual');
end;
$$;

create or replace function public.process_expired_review_windows(p_limit integer default 25)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_preview public.previews%rowtype;
  v_now timestamptz := statement_timestamp();
  v_ids uuid[] := array[]::uuid[];
  v_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'invalid_batch_limit' using errcode = 'P0001'; end if;
  for v_order in
    select o.* from public.orders o
    where o.status = 'preview_ready' and o.approved_at is null
      and exists (
        select 1 from public.previews p where p.order_id = o.id
          and p.review_deadline_at <= v_now and p.review_closed_at is null
          and p.id = (select p2.id from public.previews p2 where p2.order_id = o.id order by p2.version_number desc limit 1)
      )
    order by o.updated_at for update skip locked limit p_limit
  loop
    select * into v_preview from public.previews where order_id = v_order.id order by version_number desc limit 1 for update;
    if v_preview.id is null or v_preview.review_deadline_at is null or v_preview.review_deadline_at > v_now
       or v_preview.review_closed_at is not null or exists (
         select 1 from public.revision_requests where order_id = v_order.id and status = 'open'
       ) then continue; end if;

    update public.previews set review_closed_at = v_now, review_expired_at = v_now where id = v_preview.id;
    update public.orders set status = 'approved', approved_preview_id = v_preview.id,
      approved_at = v_now, approval_source = 'automatic_72h', production_ready = true, updated_at = v_now
      where id = v_order.id and status = 'preview_ready' and approved_at is null;
    if not found then continue; end if;
    insert into public.audit_events (order_id, event_type, event_data) values
      (v_order.id, 'review_window_expired', jsonb_build_object('previewId', v_preview.id, 'deadline', v_preview.review_deadline_at)),
      (v_order.id, 'artwork_auto_approved', jsonb_build_object('previewId', v_preview.id, 'source', 'automatic_72h'));
    insert into public.notification_deliveries (order_id, preview_id, kind, review_sequence)
      values (v_order.id, v_preview.id, 'automatic_approval', v_preview.review_sequence) on conflict (preview_id, kind, review_sequence) do nothing;
    v_ids := array_append(v_ids, v_order.id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('processed', v_count, 'orderIds', to_jsonb(v_ids));
end;
$$;

create or replace function public.queue_due_review_reminders()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := statement_timestamp(); v_24 integer; v_6 integer;
begin
  insert into public.notification_deliveries (order_id, preview_id, kind, review_sequence)
    select o.id, p.id, 'reminder_24h', p.review_sequence from public.orders o join public.previews p on p.order_id=o.id
    where o.status='preview_ready' and o.approved_at is null and p.review_closed_at is null
      and p.review_deadline_at > v_now and p.review_deadline_at <= v_now + interval '24 hours'
      and p.id=(select p2.id from public.previews p2 where p2.order_id=o.id order by p2.version_number desc limit 1)
    on conflict (preview_id, kind, review_sequence) do nothing;
  get diagnostics v_24 = row_count;
  insert into public.notification_deliveries (order_id, preview_id, kind, review_sequence)
    select o.id, p.id, 'reminder_6h', p.review_sequence from public.orders o join public.previews p on p.order_id=o.id
    where o.status='preview_ready' and o.approved_at is null and p.review_closed_at is null
      and p.review_deadline_at > v_now and p.review_deadline_at <= v_now + interval '6 hours'
      and p.id=(select p2.id from public.previews p2 where p2.order_id=o.id order by p2.version_number desc limit 1)
    on conflict (preview_id, kind, review_sequence) do nothing;
  get diagnostics v_6 = row_count;
  return jsonb_build_object('queued24h',v_24,'queued6h',v_6);
end;
$$;

create or replace function public.claim_review_notifications(p_limit integer default 25)
returns setof public.notification_deliveries language plpgsql security invoker set search_path = '' as $$
begin
  return query
  with candidates as (
    select id from public.notification_deliveries
    where (status in ('pending','failed') or (status='processing' and claimed_at < statement_timestamp()-interval '10 minutes'))
      and available_at <= statement_timestamp() and attempts < 8
    order by available_at, created_at for update skip locked limit greatest(1,least(p_limit,100))
  )
  update public.notification_deliveries n set status='processing', claimed_at=statement_timestamp(),
    attempts=n.attempts+1, updated_at=statement_timestamp()
  from candidates c where n.id=c.id returning n.*;
end;
$$;

create or replace function public.restart_review_window(p_order_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.orders%rowtype; v_preview public.previews%rowtype; v_now timestamptz:=statement_timestamp(); v_deadline timestamptz:=statement_timestamp()+interval '72 hours'; v_sequence integer;
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode='P0001'; end if;
  if v_order.status <> 'preview_ready' or v_order.approved_at is not null then raise exception 'invalid_review_restart_state' using errcode='P0001'; end if;
  if exists(select 1 from public.revision_requests where order_id=p_order_id and status='open') then raise exception 'open_revision_exists' using errcode='P0001'; end if;
  select * into v_preview from public.previews where order_id=p_order_id order by version_number desc limit 1 for update;
  if v_preview.id is null then raise exception 'preview_not_found' using errcode='P0001'; end if;
  v_sequence := v_preview.review_sequence + 1;
  update public.previews set review_started_at=v_now,review_deadline_at=v_deadline,review_closed_at=null,review_expired_at=null,review_sequence=v_sequence where id=v_preview.id;
  insert into public.audit_events(order_id,event_type,event_data) values
    (p_order_id,'review_window_restarted',jsonb_build_object('previewId',v_preview.id,'deadline',v_deadline));
  insert into public.notification_deliveries(order_id,preview_id,kind,review_sequence) values(p_order_id,v_preview.id,'preview_ready',v_sequence)
    on conflict(preview_id,kind,review_sequence) do nothing;
  return jsonb_build_object('previewId',v_preview.id,'reviewStartedAt',v_now,'reviewDeadlineAt',v_deadline);
end;
$$;

revoke all on table public.notification_deliveries from public, anon, authenticated;
grant all on table public.notification_deliveries to service_role;
revoke all on function public.process_expired_review_windows(integer) from public, anon, authenticated;
revoke all on function public.queue_due_review_reminders() from public, anon, authenticated;
revoke all on function public.claim_review_notifications(integer) from public, anon, authenticated;
revoke all on function public.restart_review_window(uuid) from public, anon, authenticated;
grant execute on function public.process_expired_review_windows(integer) to service_role;
grant execute on function public.queue_due_review_reminders() to service_role;
grant execute on function public.claim_review_notifications(integer) to service_role;
grant execute on function public.restart_review_window(uuid) to service_role;
