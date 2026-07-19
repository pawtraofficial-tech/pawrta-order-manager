import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isAdminRequest } from "@/lib/admin-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { data: order, error } = await getSupabaseAdmin().from("orders").select("*").eq("id", id).single();
  if (error || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const [{ data: previewRows }, { data: revisions }, { data: events }] = await Promise.all([
    getSupabaseAdmin().from("previews").select("id,version_number,storage_path,label,created_at").eq("order_id", id).order("version_number"),
    getSupabaseAdmin().from("revision_requests").select("id,preview_id,message,status,created_at,completed_at").eq("order_id", id).order("created_at", { ascending: false }),
    getSupabaseAdmin().from("audit_events").select("id,event_type,event_data,created_at").eq("order_id", id).order("created_at", { ascending: false }).limit(30),
  ]);
  const previews = await Promise.all((previewRows || []).map(async (row) => {
    const { data } = await getSupabaseAdmin().storage.from("previews").createSignedUrl(row.storage_path, 3600);
    return { ...row, imageUrl: data?.signedUrl || null };
  }));
  return NextResponse.json({ order: { ...order, previews, revisionRequests: revisions || [], auditEvents: events || [] } });
}
