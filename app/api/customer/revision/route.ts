import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, sendEmail } from "@/lib/email";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email(), previewId: z.string().uuid(), message: z.string().trim().min(5).max(2000) });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Describe the requested changes in at least 5 characters." }, { status: 400 });
  const orderNumber = parsed.data.orderNumber.trim().replace(/^#/, "");
  const email = parsed.data.email.trim().toLowerCase();
  const { data: order } = await getSupabaseAdmin().from("orders").select("*").eq("order_number", orderNumber).eq("customer_email", email).maybeSingle();
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  if (order.approved_at) return NextResponse.json({ error: "Approved artwork can no longer be revised." }, { status: 409 });
  if (order.revision_count >= 3) return NextResponse.json({ error: "Your three free revision rounds have been used." }, { status: 409 });
  const { data: preview } = await getSupabaseAdmin().from("previews").select("id").eq("id", parsed.data.previewId).eq("order_id", order.id).maybeSingle();
  if (!preview) return NextResponse.json({ error: "Selected preview does not belong to this order." }, { status: 400 });
  const { data: open } = await getSupabaseAdmin().from("revision_requests").select("id").eq("order_id", order.id).eq("status", "open").limit(1);
  if (open?.length) return NextResponse.json({ error: "You already have an open revision request." }, { status: 409 });

  const next = order.revision_count + 1;
  const request = await getSupabaseAdmin().from("revision_requests").insert({ order_id: order.id, preview_id: preview.id, message: parsed.data.message }).select("id").single();
  if (request.error) return NextResponse.json({ error: "Revision request failed." }, { status: 500 });
  const now = new Date().toISOString();
  await getSupabaseAdmin().from("orders").update({ status: "revision_requested", revision_count: next, updated_at: now }).eq("id", order.id);
  await audit(order.id, "customer_revision_requested", { revisionId: request.data.id, previewId: preview.id, revisionCount: next });
  await syncOrderState(order.shopify_order_id, { status: "revision_requested", revisionCount: next }).catch(console.error);
  const adminEmail = process.env.PAWTRA_ADMIN_EMAIL;
  if (adminEmail) await sendEmail({ to: adminEmail, subject: `Revision requested — #${order.order_number}`, html: `<p>A customer requested revision ${next}/3 for order <strong>#${order.order_number}</strong>.</p><blockquote>${parsed.data.message.replace(/[<>]/g, "")}</blockquote><p><a href="${appUrl("/admin")}">Open Pawtra Admin</a></p>` }).catch(console.error);
  return NextResponse.json({ ok: true, revisionCount: next, remainingFreeRevisions: 3 - next });
}
