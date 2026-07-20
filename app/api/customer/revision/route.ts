import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, escapeEmailHtml, sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeEmail, normalizeOrderNumber } from "@/lib/workflow";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email().max(320), previewId: z.string().uuid(), message: z.string().trim().min(5).max(2000) });

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "customer-mutation", 10, 10 * 60 * 1000);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Describe the requested changes in 5–2,000 characters." }, { status: 400 });
  const orderNumber = normalizeOrderNumber(parsed.data.orderNumber);
  const email = normalizeEmail(parsed.data.email);
  const db = getSupabaseAdmin();
  const { data: order, error: orderError } = await db.from("orders").select("id,shopify_order_id,order_number,revision_count,approved_at").eq("order_number", orderNumber).eq("customer_email", email).maybeSingle();
  if (orderError) {
    console.error("Revision lookup failed", orderError.message);
    return NextResponse.json({ error: "Revision request could not be completed." }, { status: 500 });
  }
  if (!order) return NextResponse.json({ error: "The order details could not be verified." }, { status: 404 });

  const result = await db.rpc("request_artwork_revision", { p_order_id: order.id, p_preview_id: parsed.data.previewId, p_message: parsed.data.message });
  if (result.error) {
    const known = result.error.message;
    if (known.includes("revision_limit_reached")) return NextResponse.json({ error: "Your three free revision rounds have been used." }, { status: 409 });
    if (known.includes("open_revision_exists")) return NextResponse.json({ error: "You already have an open revision request." }, { status: 409 });
    if (/order_locked|invalid_revision_state|preview_not_latest/.test(known)) return NextResponse.json({ error: "A revision cannot be requested for this preview." }, { status: 409 });
    console.error("Revision transaction failed", result.error.message);
    return NextResponse.json({ error: "Revision request could not be completed." }, { status: 500 });
  }
  const workflow = result.data as { revisionCount: number };
  const warnings: string[] = [];
  try {
    await syncOrderState(order.shopify_order_id, { status: "revision_requested", revisionCount: workflow.revisionCount });
  } catch (error) {
    warnings.push("shopify_sync_failed");
    console.error("Shopify revision sync failed", error);
  }
  let emailSent = false;
  const adminEmail = process.env.PAWTRA_ADMIN_EMAIL;
  if (adminEmail) {
    try {
      const sent = await sendEmail({ to: adminEmail, subject: `Revision requested — #${escapeEmailHtml(order.order_number)}`, html: `<p>A customer requested revision ${workflow.revisionCount}/3 for order <strong>#${escapeEmailHtml(order.order_number)}</strong>.</p><blockquote>${escapeEmailHtml(parsed.data.message)}</blockquote><p><a href="${appUrl("/admin")}">Open Pawtra Admin</a></p>` });
      emailSent = sent.sent;
    } catch (error) {
      warnings.push("email_failed");
      console.error("Revision email failed", error);
    }
  }
  return NextResponse.json({ ok: true, revisionCount: workflow.revisionCount, remainingFreeRevisions: 3 - workflow.revisionCount, emailSent, warnings });
}
