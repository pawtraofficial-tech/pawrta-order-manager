import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/admin-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, escapeEmailHtml, sendEmail } from "@/lib/email";

const inputSchema = z.object({ action: z.enum(["mark_production", "mark_shipped"]) });
const targets = { mark_production: "in_production", mark_shipped: "shipped" } as const;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const input = inputSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  const db = getSupabaseAdmin();
  const { data: order, error: orderError } = await db.from("orders").select("id,shopify_order_id,order_number,customer_email,customer_name,status,revision_count,approved_at,production_ready").eq("id", id).maybeSingle();
  if (orderError) return NextResponse.json({ error: "Order could not be loaded." }, { status: 500 });
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

  const status = targets[input.data.action];
  const transition = await db.rpc("transition_order_status", { p_order_id: id, p_next_status: status });
  if (transition.error) {
    if (transition.error.message.includes("invalid_status_transition")) return NextResponse.json({ error: "That status transition is not allowed." }, { status: 409 });
    console.error("Status transition failed", transition.error.message);
    return NextResponse.json({ error: "Status could not be updated." }, { status: 500 });
  }
  const workflow = transition.data as { changed: boolean };
  if (!workflow.changed) return NextResponse.json({ ok: true, status, alreadyApplied: true, emailSent: false });

  const warnings: string[] = [];
  try {
    await syncOrderState(order.shopify_order_id, { status, revisionCount: order.revision_count, approved: Boolean(order.approved_at), productionReady: true });
  } catch (error) {
    warnings.push("shopify_sync_failed");
    console.error("Shopify status sync failed", error);
  }
  let emailSent = false;
  try {
    const sent = await sendEmail({
      to: order.customer_email,
      subject: status === "in_production" ? `Your Pawtra artwork is in production — #${escapeEmailHtml(order.order_number)}` : `Your Pawtra order has shipped — #${escapeEmailHtml(order.order_number)}`,
      html: `<p>Hello ${escapeEmailHtml(order.customer_name || "there")},</p><p>Your order <strong>#${escapeEmailHtml(order.order_number)}</strong> is now <strong>${status.replaceAll("_", " ")}</strong>.</p><p><a href="${appUrl("/track")}">View your order</a></p>`,
    });
    emailSent = sent.sent;
    if (!sent.sent) warnings.push("email_not_configured");
  } catch (error) {
    warnings.push("email_failed");
    console.error("Status email failed", error);
  }
  return NextResponse.json({ ok: true, status, alreadyApplied: false, emailSent, warnings });
}
