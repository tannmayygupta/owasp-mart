---
title: 'C08 Software or Data Integrity Failures (unsigned payment webhook)'
type: 'feature'
ticket: '4'
created: '2026-10-18'
status: 'done'
baseline_revision: 'f8d6882'
route: 'full'
risk: 'high'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C08 (OWASP A08, CWE-345) needs a data-integrity flaw: a payment webhook that accepts an unsigned event. The gateway signs events with an HMAC; a test-mode bypass left in production skips the check.

**Approach:** Add `POST /webhooks/payments` and a pending-order path (`POST /api/orders/pending`). The fixed (default) build always verifies the HMAC; an unsigned/badly-signed event is 400 whatever headers it carries. The vulnerable build skips the signature check when `X-Gateway-Mode: sandbox` is present, so a player replays an unsigned event and turns their own pending order paid. A payment accepted through the bypass is stored `verified=0` and its `payment_ref` is the sentinel flag; the amount-equals-total and order-is-pending checks still run. Events `webhook.received` (source, accepted), `order.paid` (verified).

## Boundaries & Constraints

**Always:** Default to fixed (verify always). Only `payment_pending` orders change. A bypass-paid order is `verified=0` and must not be refundable (so it never feeds C04). The sandbox header exists on no other route.

**Never:** No real flag committed (neutral marker). No flag from an honest checkout or a correctly-signed event. The gateway key is not a flag and is not exposed elsewhere.

## I/O & Edge-Case Matrix

| Build | Request | Result |
|-------|---------|--------|
| vulnerable | unsigned + `X-Gateway-Mode: sandbox` | accepted, order paid, `payment_ref`=flag, `order.paid` verified=false |
| fixed | unsigned + sandbox header | 400 |
| either | correctly signed | accepted, verified=true, normal ref, no flag |
| either | unsigned, no sandbox header | 400 |
| either | amount ≠ total / not pending | 400 |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0007_payment_webhook.sql` — `payments.payment_ref`, `payments.verified`.
- `apps/shop/src/challenges/c08-payment-webhook.mjs` — webhook handler (both branches), pending-order, signer, route registrar.
- `apps/shop/src/app.mjs` — `registerWebhookRoutes` before `checkCsrf`.
- `apps/shop/src/web/routes.mjs` — `POST /api/orders/pending`.
- `challenges/tests/c08-payment-webhook/{exploit.mjs,c08.test.mjs}`.

## Tasks & Acceptance

- [x] Migration, webhook (both branches), pending order, exploit + self-test.

**Acceptance:** the unsigned sandbox webhook pays the order and yields the flag on the vulnerable build (order.paid verified=false) and is rejected on the fixed build; a signed event is accepted on both but never yields the flag; an unsigned event without the header is rejected on both.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C08 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
