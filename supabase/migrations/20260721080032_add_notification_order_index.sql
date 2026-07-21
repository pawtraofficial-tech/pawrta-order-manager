create index if not exists notification_deliveries_order_id_idx
  on public.notification_deliveries (order_id, created_at desc);
