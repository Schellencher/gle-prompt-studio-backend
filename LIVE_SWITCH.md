# LIVE SWITCH – Step 4 (Backend)

## Ziel

Backend (Render) von TEST → LIVE umstellen, ohne gemischte IDs/Keys.

## Render – Environment Variables (ersetzen)

- STRIPE*SECRET_KEY: sk_live*...
- STRIPE*PRICE_ID: price*... (LIVE Preis-ID)
- STRIPE*WEBHOOK_SECRET: whsec*... (LIVE Webhook Secret)

## URLs (LIVE)

- FRONTEND_URL: https://<live-frontend>
- CORS_ORIGIN: https://<live-frontend>
- STRIPE_BILLING_RETURN_URL: https://<live-frontend>

## Deploy

- Save env vars
- Manual Deploy → Deploy latest commit

## Check nach Deploy

- GET /api/health → stripeMode sollte LIVE anzeigen
- /api/me → plan/stripe OK
- Checkout öffnen → LIVE Checkout Session
- Billing Portal öffnen → LIVE Portal URL
