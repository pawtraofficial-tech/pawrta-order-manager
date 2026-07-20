# Pawtra Order Manager

Pawtra Order Manager is a Next.js 15 App Router application for Shopify order intake, private artwork review, up to three revision rounds, final approval, production, shipping, notifications, and audit history.

## Local development

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Quality checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Environment variables

Never commit values. All variables below are server-only except names beginning with `NEXT_PUBLIC_`.

Required for local development, Vercel Preview, and Vercel Production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAWTRA_ADMIN_KEY`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL` — the URL for the current environment

Optional legacy compatibility:

- `SHOPIFY_ADMIN_ACCESS_TOKEN` (optional legacy fallback)

Optional email notifications:

- `RESEND_API_KEY`
- `PAWTRA_FROM_EMAIL`
- `PAWTRA_ADMIN_EMAIL`

`RESEND_API_KEY` and `PAWTRA_FROM_EMAIL` must both be present for delivery. API responses distinguish a committed workflow change from confirmed email delivery.

## Supabase

The application uses a server-only service-role client. RLS is enabled on all application tables and no public policies are intentionally present. The `previews` bucket is private; database rows store stable object paths and the application generates one-hour signed URLs at read time.

Apply migration files in `supabase/migrations` in version order. Do not reset the database or rerun a migration already present in Supabase migration history. The hardening migration adds:

- authoritative and atomic preview, revision, approval, production, shipping, and webhook functions
- per-order preview version uniqueness
- one-open-revision enforcement
- three-revision and message-length enforcement
- lookup/dashboard indexes
- private bucket MIME and 12 MB size limits
- service-role-only execution grants for workflow functions

The application status value for production is `in_production`; `production` is invalid.

## Shopify

Register an `ORDERS_CREATE` webhook at:

```text
https://YOUR-DOMAIN/api/webhooks/shopify/orders-create
```

The endpoint validates the raw-body HMAC, `orders/create` topic, shop domain, required payload fields, and duplicate Shopify order IDs. Configure Shopify to send the `X-Shopify-Shop-Domain` header (standard for Shopify webhooks).

Metafield synchronization uses the Admin GraphQL `metafieldsSet` mutation and these `pawtra` keys:

- `artwork_status`
- `preview_url` (the stable `/track` URL, never a signed artwork URL)
- `revision_count`
- `artwork_approved`
- `production_ready`

The app needs the Shopify order scopes required to receive order webhooks and write order metafields (normally `read_orders` and `write_orders`). Confirm the exact scopes in the custom app configuration and reauthorize the app if scopes change.

Apps created in Shopify's Dev Dashboard use the client-credentials grant. The server exchanges `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for a 24-hour Admin API token and refreshes it before expiry. `SHOPIFY_ADMIN_ACCESS_TOKEN` remains supported only as a legacy fallback.

Do not modify the live theme. To add customer navigation, duplicate the current theme, keep the duplicate unpublished, add a “Track My Order” link to `/track`, preview it, and publish only after explicit approval.

## Workflow guarantees

- Version 1 is the initial design; versions 2–4 are revision rounds 1–3.
- A revised upload completes only the latest open request and records both `revision_completed` and `preview_uploaded`.
- Approval is idempotent, requires the latest preview, and is blocked by an open revision.
- Only `approved → in_production → shipped` admin transitions are permitted.
- Shopify webhook retries do not duplicate orders or creation audit events.
- Customer lookup and mutation routes use exact normalized identifiers and per-instance rate limiting.

## Operational notes

The in-memory rate limiter is a best-effort abuse control per server instance. For high-volume or coordinated attacks, add a shared Vercel Firewall or durable rate-limit store. Email and Shopify synchronization are external side effects after the authoritative database transaction; failures are logged and returned as warnings without lying about the committed order state.
