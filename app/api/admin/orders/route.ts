import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isAdminRequest } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  let query = supabaseAdmin
    .from("orders")
    .select("id,order_number,customer_name,customer_email,status,revision_count,production_ready,updated_at,created_at")
    .order("updated_at", { ascending: false });
  if (status && status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Orders could not be loaded." }, { status: 500 });
  return NextResponse.json({ orders: data || [] });
}
