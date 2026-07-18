import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, sendEmail } from "@/lib/email";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email(), previewId: z.string().uuid() });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid approval request." }, { status: 400 });
  const orderNumber = parsed.data.orderNumber.trim().replace(/^#/, "");
  const email = parsed.data.email.trim().toLowerCase();
  const { data: order } = await supabaseAdmin.from("orders").select("*").eq("order_number", orderNumber).eq("customer_email", email).maybeSingle();
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  if (order.approved_at) return NextResponse.json({ error: "This artwork has already been approved." }, { status: 409 });
  const { data: preview } = await supabaseAdmin.from("previews").select("id,storage_path").eq("id", parsed.data.previewId).eq("order_id", order.id).maybeSingle();
  if (!preview) return NextResponse.json({ error: "Selected preview does not belong to this order." }, { status: 400 });
  const { data: openRevision } = await supabaseAdmin.from("revision_requests").select("id").eq("order_id", order.id).eq("status", "open").limit(1);
  if (openRevision?.length) return NextResponse.json({ error: "A revision request is still open." }, { status: 409 });

  const now = new Date().toISOString();
  const update = await supabaseAdmin.from("orders").update({ status: "approved", approved_preview_id: preview.id, approved_at: now, production_ready: true, updated_at: now }).eq("id", order.id).is("approved_at", null);
  if (update.error) return NextResponse.json({ error: "Approval failed." }, { status: 500 });
  await audit(order.id, "customer_approved", { previewId: preview.id });
  const signed = await supabaseAdmin.storage.from("previews").createSignedUrl(preview.storage_path, 60 * 60 * 24 * 7);
  await syncOrderState(order.shopify_order_id, { status: "approved", previewUrl: signed.data?.signedUrl, revisionCount: order.revision_count, approved: true, productionReady: true }).catch(console.error);
  const adminEmail = process.env.PAWTRA_ADMIN_EMAIL;
  if (adminEmail) await sendEmail({ to: adminEmail, subject: `Artwork approved — #${order.order_number}`, html: `<p>Order <strong>#${order.order_number}</strong> was approved and is ready for production.</p><p><a href="${appUrl("/admin")}">Open Pawtra Admin</a></p>` }).catch(console.error);
  return NextResponse.json({ ok: true });
}
