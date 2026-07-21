import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isAdminRequest } from "@/lib/admin-auth";
import { processReviewDeadlines } from "@/lib/review-processing";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try { await processReviewDeadlines(25, false); } catch (processingError) {
    console.error("Admin lazy deadline processing failed", processingError instanceof Error ? processingError.message : "unknown");
  }
  const { data: order, error } = await getSupabaseAdmin().from("orders").select("*").eq("id", id).single();
  if (error || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const [previewResult, revisionResult, eventResult] = await Promise.all([
    getSupabaseAdmin().from("previews").select("id,version_number,storage_path,label,created_at,review_started_at,review_deadline_at,review_closed_at,review_expired_at").eq("order_id", id).order("version_number"),
    getSupabaseAdmin().from("revision_requests").select("id,preview_id,message,status,created_at,completed_at").eq("order_id", id).order("created_at", { ascending: false }),
    getSupabaseAdmin().from("audit_events").select("id,event_type,event_data,created_at").eq("order_id", id).order("created_at", { ascending: false }).limit(30),
  ]);
  if (previewResult.error || revisionResult.error || eventResult.error) {
    console.error("Admin order detail query failed", previewResult.error?.message || revisionResult.error?.message || eventResult.error?.message);
    return NextResponse.json({ error: "Order details could not be loaded." }, { status: 500 });
  }
  const previews = await Promise.all((previewResult.data || []).map(async (row) => {
    const { data, error: signedError } = await getSupabaseAdmin().storage.from("previews").createSignedUrl(row.storage_path, 3600);
    if (signedError) {
      console.error("Admin preview signing failed", signedError.message);
      return null;
    }
    return { ...row, imageUrl: data.signedUrl };
  }));
  if (previews.some((preview) => preview === null)) return NextResponse.json({ error: "Artwork previews could not be loaded." }, { status: 500 });
  const notificationResult = await getSupabaseAdmin().from("notification_deliveries")
    .select("id,preview_id,kind,status,attempts,sent_at,last_error_code,updated_at").eq("order_id", id).order("created_at", { ascending: false });
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
  const shopifyNumericId = String(order.shopify_order_id || "").split("/").at(-1);
  const shopifyAdminUrl = shopDomain && /^\d+$/.test(shopifyNumericId || "") ? `https://admin.shopify.com/store/${shopDomain.replace(/\.myshopify\.com$/i, "")}/orders/${shopifyNumericId}` : null;
  return NextResponse.json({ serverNow: new Date().toISOString(), order: { ...order, shopifyAdminUrl, previews,
    revisionRequests: revisionResult.data || [], auditEvents: eventResult.data || [], notifications: notificationResult.data || [] } });
}
