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
- `CRON_SECRET` — unique server-only bearer secret used by Vercel Cron
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

The additive `add_review_deadlines` migration stores a historical 72-hour window on each preview, records `manual` versus `automatic_72h` approval, and adds a durable idempotent notification queue. Existing previews are deliberately left without an active deadline; a new preview upload or a confirmed admin restart begins a window. This prevents deployment from unexpectedly approving an existing customer order.

## Review deadline processor

`GET /api/cron/review-deadlines` requires `Authorization: Bearer CRON_SECRET`. The database processor locks orders and previews, approves only an expired latest preview with no open revision, and records each outcome once. The current Vercel Hobby plan supports daily cron, configured in `vercel.json`. Customer lookup and admin detail also invoke the same database processor lazily, so correctness does not depend on the browser or the daily schedule.

Email deliveries are durable per preview/review cycle. Resend receives a stable idempotency key; failed deliveries remain visible in admin and are retried by later processor runs. Database approval is never rolled back because an email or Shopify request failed.

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

The integration targets Admin GraphQL API `2026-07`. Its existing minimum scopes remain `read_orders` for order/webhook access and `write_orders` for order metafields; no broader scope is needed for the review workflow.

Do not modify the live theme. To add customer navigation, duplicate the current theme, keep the duplicate unpublished, add a “Track My Order” link to `/track`, preview it, and publish only after explicit approval.

## Workflow guarantees

- Version 1 is the initial design; versions 2–4 are revision rounds 1–3.
- A revised upload completes only the latest open request and records both `revision_completed` and `preview_uploaded`.
- Approval is idempotent, requires the latest preview, and is blocked by an open revision.
- Only `approved → in_production → shipped` admin transitions are permitted.
- Shopify webhook retries do not duplicate orders or creation audit events.
- Customer lookup, customer mutation, and admin login routes use exact normalized identifiers and an atomic shared Supabase rate limiter. Only a one-way hash of the client address is stored. An in-memory bucket is retained as a temporary fail-safe.

## Operational notes

Email and Shopify synchronization are external side effects after the authoritative database transaction; failures are logged and returned as warnings without lying about the committed order state. The shared admin secret remains appropriate for this small release; multi-user identity, roles, and per-user audit attribution are a future improvement.
