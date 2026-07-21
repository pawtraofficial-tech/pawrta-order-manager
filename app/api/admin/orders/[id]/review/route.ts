import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRequest } from "@/lib/admin-auth";
import { deliverReviewNotifications } from "@/lib/review-processing";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const schema = z.object({ action: z.enum(["restart", "retry_email"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid review action." }, { status: 400 });
  const { id } = await params;
  const db = getSupabaseAdmin();
  if (input.data.action === "restart") {
    const result = await db.rpc("restart_review_window", { p_order_id: id });
    if (result.error) {
      const conflict = /invalid_review_restart_state|open_revision_exists|preview_not_found/.test(result.error.message);
      return NextResponse.json({ error: conflict ? "The review window cannot be restarted in this order state." : "Review window restart failed." }, { status: conflict ? 409 : 500 });
    }
    const delivery = await deliverReviewNotifications(10).catch(() => null);
    return NextResponse.json({ ok: true, ...result.data, emailSent: Boolean(delivery?.sent) });
  }

  const latest = await db.from("notification_deliveries").select("id,status")
    .eq("order_id", id).in("kind", ["preview_ready", "revision_ready"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error || !latest.data) return NextResponse.json({ error: "No review email is available to retry." }, { status: 404 });
  if (latest.data.status === "sent") return NextResponse.json({ ok: true, alreadySent: true });
  await db.from("notification_deliveries").update({ status: "pending", available_at: new Date().toISOString(), claimed_at: null, last_error_code: null }).eq("id", latest.data.id);
  await audit(id, "review_email_retry_requested", { deliveryId: latest.data.id });
  const delivery = await deliverReviewNotifications(10);
  return NextResponse.json({ ok: true, emailSent: delivery.sent > 0 });
}
