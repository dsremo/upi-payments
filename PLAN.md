# UPI Payments Orchestrator — build plan (in parts)

Original payment-orchestration service (NOT derived from work pg-application-service).
UPI-first. Cloudflare Worker + D1. Mock UPI gateway (keyless, live now) + pluggable Razorpay-test adapter.
Live target: pay.dsremo.com

## Parts
- [x] 1. Scaffold + D1 (this) — dir, schema, wrangler.toml, create DB
- [x] 2. Core: POST /api/payments (idempotent), state machine created→pending→success/failed/expired, mock UPI collect — tested locally (create→pending, idempotency, approve→success, decline→failed, 409 on terminal, 400 invalid amount, lazy 600s expiry)
- [x] 3. Webhook: POST /api/webhook (HMAC-SHA256 verify, timing-safe), GET status, reconciliation — Razorpay adapter (real order on RAZORPAY_KEY_ID/SECRET, else keyless mock); tested invalid-sig→401, valid-sig pending→success, replay idempotent
- [x] 4. Checkout demo UI at /checkout (amount -> Razorpay Checkout / mock hint -> polls live status)
- [x] 5. Deploy + custom domain pay.dsremo.com — LIVE in mock mode, e2e tested (create/approve/webhook-guard). Razorpay live e2e pending test keys (set via Chrome flow).
- [ ] 6. README + Mermaid + push repo + add to portfolio + resumes (Backend/Payments)
- [x] LIVE Razorpay (test mode): RAZORPAY_KEY_ID/SECRET set as Worker secrets; added POST /api/verify-payment (HMAC order_id|payment_id == razorpay_signature, tested valid/mismatch/missing); /checkout calls it; live create returns real order_ (confirmed). REMAINING: user does the browser checkout at /checkout with test VPA success@razorpay; optional RAZORPAY_WEBHOOK_SECRET + dashboard webhook for the backstop. SECRET was pasted in chat → regenerate test key when done.

## Design notes
- Idempotency-Key header -> unique; same key returns same payment.
- Webhook HMAC-SHA256 signature (X-Signature) verified before status update.
- State machine enforced server-side; events table logs every transition.
- Razorpay adapter behind RAZORPAY_KEY secret (optional); mock used when absent.
