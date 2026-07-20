import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function audit(orderId: string, eventType: string, eventData: Record<string, unknown> = {}) {
  const { error } = await getSupabaseAdmin().from("audit_events").insert({
    order_id: orderId,
    event_type: eventType,
    event_data: eventData,
  });
  if (error) throw new Error(`Audit insert failed: ${error.message}`);
}
