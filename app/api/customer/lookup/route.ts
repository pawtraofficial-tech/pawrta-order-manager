import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

const schema = z.object({ orderNumber: z.string().min(2).max(40), email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid order number and email." }, { status: 400 });
  const orderNumber = parsed.data.orderNumber.trim().replace(/^#/, "");
  const email = parsed.data.email.trim().toLowerCase();
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id,order_number,customer_name,status,revision_count,approved_preview_id,approved_at,production_ready,updated_at")
    .eq("order_number", orderNumber)
    .eq("customer_email", email)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "Order number and email do not match." }, { status: 404 });

  const [{ data: rows }, { data: revisions }] = await Promise.all([
    supabaseAdmin.from("previews").select("id,version_number,storage_path,label,created_at").eq("order_id", order.id).order("version_number"),
    supabaseAdmin.from("revision_requests").select("id,preview_id,message,status,created_at,completed_at").eq("order_id", order.id).order("created_at", { ascending: false }),
  ]);
  const previews = await Promise.all((rows || []).map(async (row) => {
    const { data } = await supabaseAdmin.storage.from("previews").createSignedUrl(row.storage_path, 3600);
    return { id: row.id, versionNumber: row.version_number, label: row.label, imageUrl: data?.signedUrl || null, createdAt: row.created_at };
  }));
  const openRevision = (revisions || []).some((r) => r.status === "open");
  return NextResponse.json({
    order: {
      ...order,
      remainingFreeRevisions: Math.max(0, 3 - order.revision_count),
      previews,
      revisions: revisions || [],
      canApprove: previews.length > 0 && !order.approved_at && !openRevision,
      canRequestRevision: previews.length > 0 && !order.approved_at && !openRevision && order.revision_count < 3,
    },
  });
}
