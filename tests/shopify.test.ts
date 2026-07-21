import assert from "node:assert/strict";
import test from "node:test";
import { updateOrderMetafields } from "../lib/shopify";
import { verifyShopifyWebhook } from "../lib/security";
import crypto from "node:crypto";

test("client credentials are exchanged once and the token is cached", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    shop: process.env.SHOPIFY_STORE_DOMAIN,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    legacyToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  };
  process.env.SHOPIFY_STORE_DOMAIN = "test-shop.myshopify.com";
  process.env.SHOPIFY_CLIENT_ID = "client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "client-secret";
  delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/admin/oauth/access_token")) {
      return Response.json({ access_token: "temporary-token", expires_in: 86_399 });
    }
    return Response.json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
  };

  try {
    const values = [{ namespace: "pawtra", key: "artwork_status", type: "single_line_text_field", value: "approved" }];
    await updateOrderMetafields("gid://shopify/Order/1", values);
    await updateOrderMetafields("gid://shopify/Order/1", values);

    assert.equal(requests.filter(({ url }) => url.endsWith("/admin/oauth/access_token")).length, 1);
    assert.equal(requests.filter(({ url }) => url.endsWith("/graphql.json")).length, 2);
    const graphRequest = requests.find(({ url }) => url.endsWith("/graphql.json"));
    assert.equal((graphRequest?.init?.headers as Record<string, string>)["X-Shopify-Access-Token"], "temporary-token");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SHOPIFY_STORE_DOMAIN = originalEnv.shop;
    process.env.SHOPIFY_CLIENT_ID = originalEnv.clientId;
    process.env.SHOPIFY_CLIENT_SECRET = originalEnv.clientSecret;
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = originalEnv.legacyToken;
  }
});

test("Shopify webhook HMAC validates the exact raw body", () => {
  const originalSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  process.env.SHOPIFY_WEBHOOK_SECRET = "test-only-webhook-secret";
  try {
    const raw = JSON.stringify({ id: 123, name: "#1001" });
    const hmac = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET).update(raw, "utf8").digest("base64");
    assert.equal(verifyShopifyWebhook(raw, hmac), true);
    assert.equal(verifyShopifyWebhook(`${raw} `, hmac), false);
  } finally {
    process.env.SHOPIFY_WEBHOOK_SECRET = originalSecret;
  }
});
