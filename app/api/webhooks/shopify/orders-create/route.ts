import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { verifyShopifyWebhook } from "@/lib/security";
import { normalizeEmail, normalizeOrderNumber } from "@/lib/workflow";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return new NextResponse("Invalid webhook", { status: 401 });
  }
  if (req.headers.get("x-shopify-topic") !== "orders/create") {
    return new NextResponse("Unexpected topic", { status: 400 });
  }
  const configuredShop = process.env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase();
  const webhookShop = req.headers.get("x-shopify-shop-domain")?.trim().toLowerCase();
  if (!configuredShop || !webhookShop || webhookShop !== configuredShop) {
    return new NextResponse("Unexpected shop", { status: 401 });
  }

  try {
    const payload = JSON.parse(raw) as Record<string, any>;
    const emailValue = payload.email || payload.customer?.email || payload.contact_email;
    const orderNumber = normalizeOrderNumber(String(payload.order_number || payload.name || ""));
    if (!payload.id || !emailValue || !orderNumber) return new NextResponse("Required order data missing", { status: 400 });
    const email = normalizeEmail(String(emailValue));
    if (!email.includes("@") || email.length > 320) return new NextResponse("Required order data invalid", { status: 400 });

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;
    const customerName = [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(" ").slice(0, 300);
    const result = await getSupabaseAdmin().rpc("record_shopify_order", {
      p_shopify_order_id: shopifyOrderId,
      p_order_number: orderNumber,
      p_customer_email: email,
      p_customer_name: customerName,
    });
    if (result.error) throw result.error;
    return new NextResponse("OK", { status: 200 });
  } catch (error) {
    console.error("Shopify order webhook failed", error);
    return new NextResponse("Webhook processing failed", { status: 500 });
  }
}
