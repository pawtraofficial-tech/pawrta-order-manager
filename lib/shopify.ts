const shop = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
export async function updateOrderMetafields(ownerId: string, values: Array<{namespace:string;key:string;type:string;value:string;}>) {
  if (!shop || !token) return;
  const query = `mutation SetOrderMetafields($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
  const response = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables: { metafields: values.map(v => ({...v, ownerId})) } }), cache: "no-store" });
  if (!response.ok) throw new Error(`Shopify request failed: ${response.status}`);
}
