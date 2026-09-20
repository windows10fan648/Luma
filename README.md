# Luma

## Stripe subscriptions

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PREMIUM_PRICE_ID` in Vercel. The price must be a recurring Stripe Price. Add a Stripe webhook endpoint at `/api/billing/webhook` and subscribe it to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.

Members can subscribe at `/billing`. Workspace owners and admins can create limited, expiring Premium friend codes there. Codes are one-time per account and are intentionally capped by duration and redemption count.
