import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const hasShopifyAdminAuth = Boolean(
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
      (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET),
  );
  const required = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    PAWTRA_ADMIN_KEY: Boolean(process.env.PAWTRA_ADMIN_KEY),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    SHOPIFY_STORE_DOMAIN: Boolean(process.env.SHOPIFY_STORE_DOMAIN),
    SHOPIFY_WEBHOOK_SECRET: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET),
    SHOPIFY_ADMIN_AUTH: hasShopifyAdminAuth,
  };

  const missing = Object.entries(required)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  if (missing.length) {
    console.error("Health check configuration incomplete", missing.join(","));
    return NextResponse.json({ ok: false, database: false }, { status: 503 });
  }

  try {
    const { error } = await getSupabaseAdmin().from("orders").select("id", { head: true, count: "exact" }).limit(1);
    if (error) throw error;
    return NextResponse.json({ ok: true, database: true });
  } catch (error) {
    console.error("Health check failed", error);
    return NextResponse.json({ ok: false, database: false }, { status: 503 });
  }
}
