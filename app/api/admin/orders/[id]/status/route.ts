import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, sendEmail } from "@/lib/email";

const inputSchema = z.object({
  action: z.enum(["mark_in_progress", "complete_revision", "mark_production", "mark_shipped"]),
  revisionId: z.string().uuid().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const input = inputSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  const { data: order } = await supabaseAdmin.from("orders").select("*").eq("id", id).single();
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

  let status = order.status;
  let productionReady = order.production_ready;
  if (input.data.action === "mark_in_progress") status = "artwork_in_progress";
  if (input.data.action === "complete_revision") {
    if (!input.data.revisionId) return NextResponse.json({ error: "Revision ID required." }, { status: 400 });
    await supabaseAdmin.from("revision_requests").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", input.data.revisionId).eq("order_id", id);
    status = "artwork_in_progress";
  }
  if (input.data.action === "mark_production") { status = "in_production"; productionReady = true; }
  if (input.data.action === "mark_shipped") status = "shipped";

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("orders").update({ status, production_ready: productionReady, updated_at: now }).eq("id", id);
  if (error) return NextResponse.json({ error: "Status could not be updated." }, { status: 500 });
  await audit(id, `admin_${input.data.action}`, { status });
  await syncOrderState(order.shopify_order_id, { status, revisionCount: order.revision_count, approved: Boolean(order.approved_at), productionReady }).catch(console.error);
  if (["in_production", "shipped"].includes(status)) {
    await sendEmail({
      to: order.customer_email,
      subject: status === "in_production" ? `Your Pawtra artwork is in production — #${order.order_number}` : `Your Pawtra order has shipped — #${order.order_number}`,
      html: `<p>Hello ${order.customer_name || ""},</p><p>Your order <strong>#${order.order_number}</strong> is now <strong>${status.replaceAll("_", " ")}</strong>.</p><p><a href="${appUrl("/track")}">View your order</a></p>`,
    }).catch(console.error);
  }
  return NextResponse.json({ ok: true, status });
}
