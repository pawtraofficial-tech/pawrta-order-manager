import { appUrl } from "@/lib/email";

export async function updateOrderMetafields(
  ownerId: string,
  values: Array<{ namespace: string; key: string; type: string; value: string }>,
) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shop || !token) return { skipped: true };
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
  const json = await response.json();
  if (json?.errors?.length) throw new Error("Shopify GraphQL request returned errors.");
  const errors = json?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
  return json.data.metafieldsSet;
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
