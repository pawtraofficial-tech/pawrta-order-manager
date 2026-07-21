create extension if not exists pgcrypto;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  shopify_order_id text unique not null,
  order_number text not null,
  customer_email text not null,
  customer_name text,
  status text not null default 'artwork_in_progress' check (status in ('artwork_in_progress','preview_ready','revision_requested','approved','in_production','shipped')),
  revision_count integer not null default 0 check (revision_count between 0 and 3),
  approved_preview_id uuid,
  approved_at timestamptz,
  production_ready boolean not null default false,
  approval_source text check (approval_source is null or approval_source in ('manual','automatic_72h')),
  last_external_warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists orders_number_email_unique on public.orders(order_number, lower(customer_email));
create index if not exists orders_status_updated_idx on public.orders(status, updated_at desc);

create table if not exists public.previews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  version_number integer not null check (version_number between 1 and 4),
  storage_path text not null,
  label text not null,
  review_started_at timestamptz,
  review_deadline_at timestamptz,
  review_closed_at timestamptz,
  review_expired_at timestamptz,
  review_sequence integer not null default 1,
  created_at timestamptz not null default now(),
  unique(order_id, version_number)
);
alter table public.orders drop constraint if exists orders_approved_preview_id_fkey;
alter table public.orders add constraint orders_approved_preview_id_fkey foreign key(approved_preview_id) references public.previews(id) on delete set null;

create table if not exists public.revision_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  preview_id uuid references public.previews(id) on delete set null,
  message text not null check (char_length(message) between 5 and 2000),
  status text not null default 'open' check (status in ('open','completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists one_open_revision_per_order on public.revision_requests(order_id) where status = 'open';

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_order_created_idx on public.audit_events(order_id, created_at desc);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  preview_id uuid not null references public.previews(id) on delete cascade,
  kind text not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  review_sequence integer not null default 1,
  unique(preview_id, kind, review_sequence)
);

create table if not exists public.rate_limit_buckets (
  scope text not null,
  bucket_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  updated_at timestamptz not null default now(),
  primary key(scope, bucket_key)
);

alter table public.orders enable row level security;
alter table public.previews enable row level security;
alter table public.revision_requests enable row level security;
alter table public.audit_events enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.rate_limit_buckets enable row level security;

-- No public policies are intentionally created. The app accesses these tables only with the server-side service-role key.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('previews', 'previews', false, 12582912, array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Apply the versioned files in supabase/migrations after this baseline schema.
-- They add transaction-safe server workflow functions and service-role-only grants.
