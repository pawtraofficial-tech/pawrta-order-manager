import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { verifyShopifyWebhook } from "@/lib/security";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return new NextResponse("Invalid webhook", { status: 401 });
  }

  try {
    const payload = JSON.parse(raw);
    const email = payload.email || payload.customer?.email || payload.contact_email;
    if (!email) return new NextResponse("Email missing", { status: 400 });

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;
    const orderNumber = String(payload.order_number || payload.name || "").replace(/^#/, "");
    if (!payload.id || !orderNumber) return new NextResponse("Order identity missing", { status: 400 });

    const customerName = [payload.customer?.first_name, payload.customer?.last_name]
      .filter(Boolean)
      .join(" ");

    const db = getSupabaseAdmin();
    const { data: existing } = await db
      .from("orders")
      .select("id")
      .eq("shopify_order_id", shopifyOrderId)
      .maybeSingle();

    if (existing) return new NextResponse("OK");

    const { data, error } = await db
      .from("orders")
      .insert({
        shopify_order_id: shopifyOrderId,
        order_number: orderNumber,
        customer_email: String(email).trim().toLowerCase(),
        customer_name: customerName,
        status: "artwork_in_progress",
      })
      .select("id")
      .single();

    if (error) throw error;
    await audit(data.id, "shopify_order_received", { shopifyOrderId, orderNumber });
    return new NextResponse("OK");
  } catch (error) {
    console.error(error);
    return new NextResponse("Database error", { status: 500 });
  }
}
