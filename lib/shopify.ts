import { appUrl } from "@/lib/email";

type ShopifyTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

let cachedAccessToken: { value: string; expiresAt: number } | null = null;
let accessTokenRequest: Promise<string> | null = null;

async function requestShopifyAccessToken(shop: string, clientId: string, clientSecret: string) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Shopify token request failed: ${response.status}`);

  const json = (await response.json()) as ShopifyTokenResponse;
  if (!json.access_token) throw new Error("Shopify token response was incomplete.");

  const lifetimeSeconds = Math.max(60, Number(json.expires_in) || 86_399);
  cachedAccessToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, lifetimeSeconds - 300) * 1_000,
  };
  return json.access_token;
}

async function getShopifyAccessToken(shop: string) {
  const legacyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (legacyToken) return legacyToken;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) return cachedAccessToken.value;
  if (!accessTokenRequest) {
    accessTokenRequest = requestShopifyAccessToken(shop, clientId, clientSecret).finally(() => {
      accessTokenRequest = null;
    });
  }
  return accessTokenRequest;
}

export async function updateOrderMetafields(
  ownerId: string,
  values: Array<{ namespace: string; key: string; type: string; value: string }>,
) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase();
  if (!shop) return { skipped: true };
  const token = await getShopifyAccessToken(shop);
  if (!token) return { skipped: true };
  const query = `mutation SetOrderMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message }
    }
  }`;
  const response = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables: { metafields: values.map((v) => ({ ...v, ownerId })) } }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Shopify request failed: ${response.status}`);
  const json = (await response.json()) as {
    errors?: Array<unknown>;
    data?: {
      metafieldsSet?: {
        metafields?: Array<{ id: string; namespace: string; key: string; value: string }>;
        userErrors?: Array<{ message: string }>;
      };
    };
  };
  if (json?.errors?.length) throw new Error("Shopify GraphQL request returned errors.");
  const errors = json?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
  return json.data?.metafieldsSet;
}

export async function syncOrderState(ownerId: string, state: {
  status: string;
  previewUrl?: string | null;
  revisionCount?: number;
  approved?: boolean;
  productionReady?: boolean;
}) {
  return updateOrderMetafields(ownerId, [
    { namespace: "pawtra", key: "artwork_status", type: "single_line_text_field", value: state.status },
    { namespace: "pawtra", key: "preview_url", type: "url", value: state.previewUrl || appUrl("/track") },
    { namespace: "pawtra", key: "revision_count", type: "number_integer", value: String(state.revisionCount ?? 0) },
    { namespace: "pawtra", key: "artwork_approved", type: "boolean", value: String(Boolean(state.approved)) },
    { namespace: "pawtra", key: "production_ready", type: "boolean", value: String(Boolean(state.productionReady)) },
  ]);
}
