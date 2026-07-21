import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isAdminRequest } from "@/lib/admin-auth";
import { syncOrderState } from "@/lib/shopify";
import { deliverReviewNotifications } from "@/lib/review-processing";
import { hasValidImageSignature, MAX_PREVIEW_FILE_SIZE, PREVIEW_MIME_TYPES } from "@/lib/workflow";

const ALLOWED = new Set<string>(PREVIEW_MIME_TYPES);

function uploadError(message?: string) {
  if (message?.includes("revision_limit_reached")) return { message: "Initial design plus three revisions limit reached.", status: 409 };
  if (message?.includes("order_locked")) return { message: "Approved orders are locked.", status: 409 };
  if (message?.includes("revision_not_requested") || message?.includes("open_revision_not_found")) {
    return { message: "A revised preview requires an open customer revision request.", status: 409 };
  }
  if (message?.includes("invalid_preview_state")) return { message: "A preview cannot be uploaded in the current order state.", status: 409 };
  return { message: "Preview records could not be updated.", status: 500 };
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let uploadedPath: string | null = null;
  try {
    const form = await req.formData();
    const orderId = String(form.get("orderId") || "");
    const file = form.get("file");
    if (!(file instanceof File) || !orderId) return NextResponse.json({ error: "Order and image are required." }, { status: 400 });
    if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Only JPG, PNG and WEBP are accepted." }, { status: 415 });
    if (file.size <= 0 || file.size > MAX_PREVIEW_FILE_SIZE) return NextResponse.json({ error: "Image must be non-empty and no larger than 12 MB." }, { status: 413 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasValidImageSignature(bytes, file.type)) return NextResponse.json({ error: "The file contents do not match the selected image type." }, { status: 415 });

    const db = getSupabaseAdmin();
    const { data: order, error: orderError } = await db.from("orders").select("id,shopify_order_id,order_number,customer_email,customer_name,status,revision_count,approved_at").eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    if (order.approved_at) return NextResponse.json({ error: "Approved orders are locked." }, { status: 409 });
    if (!["artwork_in_progress", "revision_requested"].includes(order.status)) {
      return NextResponse.json({ error: "A preview cannot be uploaded in the current order state." }, { status: 409 });
    }

    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    uploadedPath = `${orderId}/${crypto.randomUUID()}.${extension}`;
    const upload = await db.storage.from("previews").upload(uploadedPath, bytes, { contentType: file.type, upsert: false });
    if (upload.error) throw upload.error;

    const result = await db.rpc("record_preview_upload", {
      p_order_id: orderId,
      p_storage_path: uploadedPath,
      p_mime_type: file.type,
    });
    if (result.error) {
      const cleanup = await db.storage.from("previews").remove([uploadedPath]);
      if (cleanup.error) console.error("Preview cleanup failed", cleanup.error.message);
      uploadedPath = null;
      const mapped = uploadError(result.error.message);
      return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    }

    const workflow = result.data as { versionNumber: number; revised: boolean; reviewStartedAt: string; reviewDeadlineAt: string };
    const warnings: string[] = [];
    try {
      await syncOrderState(order.shopify_order_id, { status: "preview_ready", revisionCount: order.revision_count });
    } catch (error) {
      warnings.push("shopify_sync_failed");
      console.error("Shopify preview sync failed", error);
    }

    let emailSent = false;
    try {
      const delivery = await deliverReviewNotifications(10);
      emailSent = delivery.sent > 0;
      if (delivery.failed || delivery.skipped) warnings.push("email_delivery_pending");
    } catch (error) {
      warnings.push("email_failed");
      console.error("Preview email failed", error);
    }
    return NextResponse.json({ ok: true, versionNumber: workflow.versionNumber, revised: workflow.revised,
      reviewStartedAt: workflow.reviewStartedAt, reviewDeadlineAt: workflow.reviewDeadlineAt, emailSent, warnings });
  } catch (error) {
    console.error("Preview upload failed", error);
    if (uploadedPath) {
      const cleanup = await getSupabaseAdmin().storage.from("previews").remove([uploadedPath]);
      if (cleanup.error) console.error("Preview cleanup failed", cleanup.error.message);
    }
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
