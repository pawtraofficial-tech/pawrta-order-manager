-- Additive production hardening for the Pawtra order workflow.
-- All multi-table state changes are exposed only to the server-side service role.

create unique index if not exists orders_number_email_unique
  on public.orders (order_number, lower(customer_email));
create index if not exists orders_status_updated_idx
  on public.orders (status, updated_at desc);
create unique index if not exists one_open_revision_per_order
  on public.revision_requests (order_id) where status = 'open';

do $$ begin
  alter table public.previews add constraint previews_version_number_check
    check (version_number between 1 and 4);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.revision_requests add constraint revision_requests_message_check
    check (char_length(message) between 5 and 2000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.revision_requests add constraint revision_requests_completion_check
    check ((status = 'open' and completed_at is null) or (status = 'completed' and completed_at is not null));
exception when duplicate_object then null; end $$;

update storage.buckets
set public = false,
    file_size_limit = 12582912,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'previews';

create or replace function public.record_preview_upload(
  p_order_id uuid,
  p_storage_path text,
  p_mime_type text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_revision public.revision_requests%rowtype;
  v_version integer;
  v_preview_id uuid;
  v_now timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then raise exception 'order_locked' using errcode = 'P0001'; end if;
  if p_storage_path is null or length(p_storage_path) > 500 or p_storage_path not like p_order_id::text || '/%' then
    raise exception 'invalid_storage_path' using errcode = 'P0001';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'invalid_mime_type' using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) into v_version
  from public.previews where order_id = p_order_id;
  if v_version >= 4 then raise exception 'revision_limit_reached' using errcode = 'P0001'; end if;

  if v_version = 0 then
    if v_order.status <> 'artwork_in_progress' then raise exception 'invalid_preview_state' using errcode = 'P0001'; end if;
  else
    if v_order.status <> 'revision_requested' then raise exception 'revision_not_requested' using errcode = 'P0001'; end if;
    select * into v_revision from public.revision_requests
      where order_id = p_order_id and status = 'open'
      order by created_at desc limit 1 for update;
    if not found then raise exception 'open_revision_not_found' using errcode = 'P0001'; end if;
  end if;

  v_version := v_version + 1;
  insert into public.previews (order_id, version_number, storage_path, label)
  values (p_order_id, v_version, p_storage_path,
    case when v_version = 1 then 'Initial Design' else 'Revision ' || (v_version - 1)::text end)
  returning id into v_preview_id;

  if v_revision.id is not null then
    update public.revision_requests
      set status = 'completed', completed_at = v_now
      where id = v_revision.id and status = 'open';
    if not found then raise exception 'revision_completion_failed' using errcode = 'P0001'; end if;
    insert into public.audit_events (order_id, event_type, event_data)
      values (p_order_id, 'revision_completed', jsonb_build_object('revisionId', v_revision.id, 'previewId', v_preview_id));
  end if;

  update public.orders set status = 'preview_ready', updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data)
    values (p_order_id, 'preview_uploaded', jsonb_build_object('previewId', v_preview_id, 'version', v_version));

  return jsonb_build_object(
    'previewId', v_preview_id,
    'versionNumber', v_version,
    'revisionId', v_revision.id,
    'revised', v_revision.id is not null
  );
end;
$$;

create or replace function public.request_artwork_revision(
  p_order_id uuid,
  p_preview_id uuid,
  p_message text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_latest_preview uuid;
  v_revision_id uuid;
  v_count integer;
  v_now timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then raise exception 'order_locked' using errcode = 'P0001'; end if;
  if v_order.status <> 'preview_ready' then raise exception 'invalid_revision_state' using errcode = 'P0001'; end if;
  if char_length(trim(p_message)) not between 5 and 2000 then raise exception 'invalid_revision_message' using errcode = 'P0001'; end if;
  if exists (select 1 from public.revision_requests where order_id = p_order_id and status = 'open') then
    raise exception 'open_revision_exists' using errcode = 'P0001';
  end if;

  select id into v_latest_preview from public.previews
    where order_id = p_order_id order by version_number desc limit 1;
  if v_latest_preview is null or v_latest_preview <> p_preview_id then
    raise exception 'preview_not_latest' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_count from public.revision_requests where order_id = p_order_id;
  if v_count >= 3 then raise exception 'revision_limit_reached' using errcode = 'P0001'; end if;

  insert into public.revision_requests (order_id, preview_id, message)
    values (p_order_id, p_preview_id, trim(p_message)) returning id into v_revision_id;
  update public.orders set status = 'revision_requested', revision_count = v_count + 1, updated_at = v_now
    where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data)
    values (p_order_id, 'revision_requested', jsonb_build_object(
      'revisionId', v_revision_id, 'previewId', p_preview_id, 'revisionCount', v_count + 1));
  return jsonb_build_object('revisionId', v_revision_id, 'revisionCount', v_count + 1);
end;
$$;

create or replace function public.approve_artwork(
  p_order_id uuid,
  p_preview_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_latest_preview public.previews%rowtype;
  v_now timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.approved_at is not null then
    return jsonb_build_object('changed', false, 'previewId', v_order.approved_preview_id, 'approvedAt', v_order.approved_at);
  end if;
  if v_order.status <> 'preview_ready' then raise exception 'invalid_approval_state' using errcode = 'P0001'; end if;
  if exists (select 1 from public.revision_requests where order_id = p_order_id and status = 'open') then
    raise exception 'open_revision_exists' using errcode = 'P0001';
  end if;
  select * into v_latest_preview from public.previews
    where order_id = p_order_id order by version_number desc limit 1;
  if v_latest_preview.id is null or v_latest_preview.id <> p_preview_id then
    raise exception 'preview_not_latest' using errcode = 'P0001';
  end if;

  update public.orders set status = 'approved', approved_preview_id = p_preview_id,
    approved_at = v_now, production_ready = true, updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data)
    values (p_order_id, 'artwork_approved', jsonb_build_object('previewId', p_preview_id));
  return jsonb_build_object('changed', true, 'previewId', p_preview_id, 'storagePath', v_latest_preview.storage_path, 'approvedAt', v_now);
end;
$$;

create or replace function public.transition_order_status(
  p_order_id uuid,
  p_next_status text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_event text;
  v_now timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_order.status = p_next_status then return jsonb_build_object('changed', false, 'status', v_order.status); end if;
  if v_order.status = 'approved' and p_next_status = 'in_production' then
    v_event := 'moved_into_production';
  elsif v_order.status = 'in_production' and p_next_status = 'shipped' then
    v_event := 'marked_shipped';
  else
    raise exception 'invalid_status_transition' using errcode = 'P0001';
  end if;
  update public.orders set status = p_next_status, production_ready = true, updated_at = v_now where id = p_order_id;
  insert into public.audit_events (order_id, event_type, event_data)
    values (p_order_id, v_event, jsonb_build_object('from', v_order.status, 'to', p_next_status));
  return jsonb_build_object('changed', true, 'status', p_next_status);
end;
$$;

create or replace function public.record_shopify_order(
  p_shopify_order_id text,
  p_order_number text,
  p_customer_email text,
  p_customer_name text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  insert into public.orders (shopify_order_id, order_number, customer_email, customer_name, status)
  values (p_shopify_order_id, p_order_number, lower(trim(p_customer_email)), nullif(trim(p_customer_name), ''), 'artwork_in_progress')
  on conflict (shopify_order_id) do nothing returning id into v_order_id;
  if v_order_id is null then
    select id into v_order_id from public.orders where shopify_order_id = p_shopify_order_id;
    return jsonb_build_object('orderId', v_order_id, 'created', false);
  end if;
  insert into public.audit_events (order_id, event_type, event_data) values
    (v_order_id, 'shopify_webhook_received', jsonb_build_object('shopifyOrderId', p_shopify_order_id)),
    (v_order_id, 'order_created', jsonb_build_object('source', 'shopify', 'orderNumber', p_order_number));
  return jsonb_build_object('orderId', v_order_id, 'created', true);
end;
$$;

revoke all on function public.record_preview_upload(uuid, text, text) from public, anon, authenticated;
revoke all on function public.request_artwork_revision(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.approve_artwork(uuid, uuid) from public, anon, authenticated;
revoke all on function public.transition_order_status(uuid, text) from public, anon, authenticated;
revoke all on function public.record_shopify_order(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_preview_upload(uuid, text, text) to service_role;
grant execute on function public.request_artwork_revision(uuid, uuid, text) to service_role;
grant execute on function public.approve_artwork(uuid, uuid) to service_role;
grant execute on function public.transition_order_status(uuid, text) to service_role;
grant execute on function public.record_shopify_order(text, text, text, text) to service_role;
