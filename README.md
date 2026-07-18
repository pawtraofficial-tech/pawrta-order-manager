# Pawtra Order Manager v2.0

Secure customer artwork review, revision, approval and production workflow for Pawtra.

## Features
- Shopify order-created webhook
- Order lookup using order number + checkout email
- Private Supabase Storage previews with expiring signed URLs
- Initial artwork + maximum three free revision rounds
- Duplicate/open revision protection
- Final approval lock
- Secure admin session cookie
- Admin order filters, preview uploads, revision completion and production statuses
- Shopify order metafield synchronization
- Optional Resend email notifications
- Audit event history

## Required Vercel environment variables
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAWTRA_ADMIN_KEY`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_STORE_DOMAIN` (example: `your-store.myshopify.com`)
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `NEXT_PUBLIC_APP_URL` (example: `https://pawtra-order-manager.vercel.app`)

## Optional email variables
- `RESEND_API_KEY`
- `PAWTRA_FROM_EMAIL` (verified sender, example: `Pawtra <orders@pawtra.net>`)
- `PAWTRA_ADMIN_EMAIL`

## Deployment
1. Run the complete `supabase/schema.sql` in Supabase SQL Editor.
2. Confirm Storage bucket `previews` is private.
3. Add/replace the environment variables in Vercel.
4. Deploy the repository.
5. Register Shopify webhook `ORDERS_CREATE` to:
   `https://YOUR-DOMAIN/api/webhooks/shopify/orders-create`
6. Test with a Shopify test order.

## Security
The Supabase service-role key and Shopify Admin token must only exist in Vercel environment variables. Never commit them to GitHub or paste them into client-side code. Rotate any secret previously shared in chat or screenshots.
