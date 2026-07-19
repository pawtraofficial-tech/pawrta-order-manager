import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isAdminRequest } from "@/lib/admin-auth";
import { audit } from "@/lib/audit";
import { syncOrderState } from "@/lib/shopify";
import { appUrl, sendEmail } from "@/lib/email";

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const form = await req.formData();
    const orderId = String(form.get("orderId") || "");
    const file = form.get("file");
    if (!(file instanceof File) || !orderId) return NextResponse.json({ error: "Order and image are required." }, { status: 400 });
    if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Only JPG, PNG and WEBP are accepted." }, { status: 415 });
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "Image must be smaller than 12 MB." }, { status: 413 });

    const { data: order } = await getSupabaseAdmin().from("orders").select("*").eq("id", orderId).single();
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    if (order.approved_at) return NextResponse.json({ error: "Approved orders are locked." }, { status: 409 });

    const { data: existing } = await getSupabaseAdmin().from("previews").select("version_number").eq("order_id", orderId).order("version_number", { ascending: false }).limit(1);
    const version = (existing?.[0]?.version_number || 0) + 1;
    if (version > 4) return NextResponse.json({ error: "Initial design plus three revisions limit reached." }, { status: 409 });

    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${orderId}/version-${version}-${Date.now()}.${extension}`;
    const upload = await getSupabaseAdmin().storage.from("previews").upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
    if (upload.error) throw upload.error;
    const insert = await getSupabaseAdmin().from("previews").insert({ order_id: orderId, version_number: version, storage_path: path, label: version === 1 ? "Initial Design" : `Revision ${version - 1}` }).select("id").single();
    if (insert.error) { await getSupabaseAdmin().storage.from("previews").remove([path]); throw insert.error; }

    const now = new Date().toISOString();
    await getSupabaseAdmin().from("orders").update({ status: "preview_ready", updated_at: now }).eq("id", orderId);
    await audit(orderId, "preview_uploaded", { previewId: insert.data.id, version });
    const signed = await getSupabaseAdmin().storage.from("previews").createSignedUrl(path, 60 * 60 * 24 * 7);
    await syncOrderState(order.shopify_order_id, { status: "preview_ready", previewUrl: signed.data?.signedUrl, revisionCount: order.revision_count }).catch(console.error);
    await sendEmail({
      to: order.customer_email,
      subject: `Your Pawtra artwork is ready — #${order.order_number}`,
      html: `<p>Hello ${order.customer_name || ""},</p><p>Your artwork preview is ready to review.</p><p><a href="${appUrl("/track")}">Review and approve your artwork</a></p><p>You can request up to three free revision rounds before approval.</p>`,
    }).catch(console.error);
    return NextResponse.json({ ok: true, versionNumber: version });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
