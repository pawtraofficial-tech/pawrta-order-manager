import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeEmail, normalizeOrderNumber } from "@/lib/workflow";
import { processReviewDeadlines } from "@/lib/review-processing";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "customer-lookup", 20, 10 * 60 * 1000);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid order number and email." }, { status: 400 });
  const orderNumber = normalizeOrderNumber(parsed.data.orderNumber);
  const email = normalizeEmail(parsed.data.email);
  const db = getSupabaseAdmin();
  const initialOrder = await db.from("orders").select("id,order_number,customer_name,status,revision_count,approved_preview_id,approved_at,approval_source,production_ready,updated_at").eq("order_number", orderNumber).eq("customer_email", email).maybeSingle();
  let order = initialOrder.data;
  const orderError = initialOrder.error;
  if (orderError) {
    console.error("Customer order lookup failed", orderError.message);
    return NextResponse.json({ error: "Order details could not be loaded." }, { status: 500 });
  }
  if (!order) return NextResponse.json({ error: "The order details could not be verified." }, { status: 404 });

  if (order.status === "preview_ready" && !order.approved_at) {
    try {
      await processReviewDeadlines(25, false);
      const refreshed = await db.from("orders").select("id,order_number,customer_name,status,revision_count,approved_preview_id,approved_at,approval_source,production_ready,updated_at").eq("id", order.id).single();
      if (!refreshed.error) order = refreshed.data;
    } catch (error) {
      console.error("Lazy deadline processing failed", error instanceof Error ? error.message : "unknown");
    }
  }

  const [previewResult, revisionResult] = await Promise.all([
    db.from("previews").select("id,version_number,storage_path,label,created_at,review_started_at,review_deadline_at,review_closed_at,review_expired_at").eq("order_id", order.id).order("version_number"),
    db.from("revision_requests").select("id,preview_id,message,status,created_at,completed_at").eq("order_id", order.id).order("created_at", { ascending: false }),
  ]);
  if (previewResult.error || revisionResult.error) {
    console.error("Customer order detail failed", previewResult.error?.message || revisionResult.error?.message);
    return NextResponse.json({ error: "Order details could not be loaded." }, { status: 500 });
  }
  const previews = await Promise.all((previewResult.data || []).map(async (row) => {
    const { data, error } = await db.storage.from("previews").createSignedUrl(row.storage_path, 3600);
    if (error) throw new Error(`Preview signing failed: ${error.message}`);
    return { id: row.id, versionNumber: row.version_number, label: row.label, imageUrl: data.signedUrl, createdAt: row.created_at,
      reviewStartedAt: row.review_started_at, reviewDeadlineAt: row.review_deadline_at,
      reviewClosedAt: row.review_closed_at, reviewExpiredAt: row.review_expired_at };
  })).catch((error) => {
    console.error(error);
    return null;
  });
  if (!previews) return NextResponse.json({ error: "Artwork previews could not be loaded." }, { status: 500 });
  const revisions = revisionResult.data || [];
  const openRevision = revisions.some((revision) => revision.status === "open");
  const latestPreview = previews.at(-1);
  return NextResponse.json({ serverNow: new Date().toISOString(), order: {
    ...order,
    remainingFreeRevisions: Math.max(0, 3 - revisions.length),
    previews,
    revisions,
    canApprove: Boolean(latestPreview) && order.status === "preview_ready" && !order.approved_at && !openRevision,
    canRequestRevision: Boolean(latestPreview) && order.status === "preview_ready" && !order.approved_at && !openRevision && revisions.length < 3,
  } });
}
