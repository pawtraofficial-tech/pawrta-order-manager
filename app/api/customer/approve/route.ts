import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, escapeEmailHtml, sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeEmail, normalizeOrderNumber } from "@/lib/workflow";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email().max(320), previewId: z.string().uuid() });

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "customer-mutation", 10, 10 * 60 * 1000);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid approval request." }, { status: 400 });
  const orderNumber = normalizeOrderNumber(parsed.data.orderNumber);
  const email = normalizeEmail(parsed.data.email);
  const db = getSupabaseAdmin();
  const { data: order, error: orderError } = await db.from("orders").select("id,shopify_order_id,order_number,revision_count,approved_at").eq("order_number", orderNumber).eq("customer_email", email).maybeSingle();
  if (orderError) {
    console.error("Approval lookup failed", orderError.message);
    return NextResponse.json({ error: "Approval could not be completed." }, { status: 500 });
  }
  if (!order) return NextResponse.json({ error: "The order details could not be verified." }, { status: 404 });

  const result = await db.rpc("approve_artwork", { p_order_id: order.id, p_preview_id: parsed.data.previewId });
  if (result.error) {
    const conflict = /invalid_approval_state|open_revision_exists|preview_not_latest|review_window_closed|review_window_expired/.test(result.error.message);
    return NextResponse.json({ error: conflict ? "Only the latest available preview can be approved." : "Approval could not be completed." }, { status: conflict ? 409 : 500 });
  }
  const workflow = result.data as { changed: boolean };
  if (!workflow.changed) return NextResponse.json({ ok: true, alreadyApproved: true, emailSent: false });

  const warnings: string[] = [];
  try {
    await syncOrderState(order.shopify_order_id, { status: "approved", revisionCount: order.revision_count, approved: true, productionReady: true });
  } catch (error) {
    warnings.push("shopify_sync_failed");
    console.error("Shopify approval sync failed", error);
  }
  let emailSent = false;
  const adminEmail = process.env.PAWTRA_ADMIN_EMAIL;
  if (adminEmail) {
    try {
      const sent = await sendEmail({ to: adminEmail, subject: `Artwork approved — #${escapeEmailHtml(order.order_number)}`, html: `<p>Order <strong>#${escapeEmailHtml(order.order_number)}</strong> was approved and is ready for production.</p><p><a href="${appUrl("/admin")}">Open Pawtra Admin</a></p>` });
      emailSent = sent.sent;
    } catch (error) {
      warnings.push("email_failed");
      console.error("Approval email failed", error);
    }
  }
  return NextResponse.json({ ok: true, alreadyApproved: false, emailSent, warnings });
}
