# T-26 C08 Software or Data Integrity Failures (unsigned payment webhook)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-challenges-c05-c08 story 6.4 |

## Requirements covered
FR-CHL-09 (C08). Challenge spec C08.

## Summary (plain language, 3-5 lines)
Built the payment webhook and a pending-order path, with the C08 weakness build-gated. The gateway signs each event with an HMAC. The fixed (default) build always verifies the signature; an unsigned event is rejected. The vulnerable build skips the check when `X-Gateway-Mode: sandbox` is present, so a player replays an unsigned event and turns their own order paid, and the response carries the sentinel `payment_ref` (the flag). An exploit test proves both.

## Why
FR-CHL-09 / C08. Trusting unsigned integration callbacks is a classic data-integrity failure (A08). A test-mode bypass left in production is the realistic root cause.

## What was built
- Migration 0007: `payments.payment_ref` and `payments.verified`.
- `c08-payment-webhook.mjs`: `handlePaymentWebhook` (both branches), `createPendingOrder`, `signPayload`, and a route registrar for `POST /webhooks/payments` (raw body for HMAC).
- `POST /api/orders/pending` (customer) to create the pending order.
- Events `webhook.received` (source gateway/non_gateway, accepted), `order.paid` (verified).

## How it works
The webhook verifies `HMAC(key, rawBody)` against `X-Gateway-Signature`. Fixed: always required. Vulnerable: skipped when `X-Gateway-Mode: sandbox`. The amount-equals-total and order-is-`payment_pending` checks always run. A bypass-accepted payment is `verified=0` and gets the sentinel `payment_ref` (the flag); a signed one is `verified=1` with a normal ref. An honest checkout or a signed event never produces the flag.

## Files changed
- `apps/shop/migrations/0007_payment_webhook.sql`, `apps/shop/src/challenges/c08-payment-webhook.mjs` — new.
- `apps/shop/src/app.mjs`, `apps/shop/src/web/routes.mjs`.
- `challenges/tests/c08-payment-webhook/{exploit.mjs,c08.test.mjs}` — new.
- `apps/shop/test/db.test.mjs` — migration count 7.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 27 pass (C08 3/3). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass.

## Security notes (vulnerable parts only)
The vulnerable branch skips HMAC verification for a sandbox-mode request (CWE-345), isolated in `c08-payment-webhook.mjs`, off by default. The fix is to always verify (constant-time, with a timestamp window + event-id idempotency as follow-ups) and remove the bypass. A bypass-paid order is `verified=0` and is not refundable, so it never feeds C04; the gateway key is not a flag.
