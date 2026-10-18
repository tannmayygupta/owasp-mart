---
title: 'C09 Logging and Alerting Failures (legacy login route not logged)'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: 'built'
baseline_revision: 'd1b4be2'
route: 'full'
risk: 'high'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C09 (OWASP A09, CWE-778) needs a logging/alerting gap: one authentication route missing from the security-event pipeline, with no lockout, so an attack leaves no trace.

**Approach:** The web login always goes through the pipeline — every attempt is written to the shop's `security_events` log and the account locks after a threshold (with an alert). A LEGACY mobile login `/m/api/v1/login` is added: the vulnerable build skips the pipeline (no event, no lockout, no rate limit); the fixed build uses the same pipeline. A slow brute force against the dormant support agent on the legacy route is then invisible and never locks, and the obtained session reads the break-glass reference (the flag) in the support case notes.

## Boundaries & Constraints

**Always:** The web login logs + locks (the contrast). Only the legacy route differs by build. The C09 proof ("attack happened, nothing logged") reads the shop's own `security_events` table. The case-notes flag is support/admin only.

**Never:** No real flag committed (neutral marker). The IF-4 platform event `shop.security_event_written` is not emitted yet (the posted schema does not list it) — deferred to the schema addition; the table is the shop-side proof.

## I/O & Edge-Case Matrix

| Route / build | Behaviour |
|---|---|
| web login (any build) | security event per attempt; lock + alert after 5 |
| legacy login, vulnerable | no event, no lockout → un-throttled brute force |
| legacy login, fixed | same pipeline as web (event + lockout) |
| case notes | support/admin session only; shows the flag |

</frozen-after-approval>

## Code Map

- `apps/shop/src/challenges/c09-logging-failures.mjs` — `recordAuth`/`isLocked`, the legacy login route, the case-note reference.
- `apps/shop/src/web/routes.mjs` — the web login now logs + locks (via `recordAuth`/`isLocked`).
- `apps/shop/src/app.mjs` — `registerLegacyLoginRoute` before `checkCsrf`.
- `apps/shop/src/web/routes-staff.mjs` + `views/staff/case-notes.njk` — the case-notes page.
- `challenges/tests/c09-logging-failures/{exploit.mjs,c09.test.mjs}`.

## Tasks & Acceptance

- [x] Web-login logging + lockout, legacy route (both branches), case notes, exploit + self-test.

**Acceptance:** the legacy brute force takes over the support agent with zero security events and reads the flag on the vulnerable build; the fixed legacy route logs + locks; the web login logs + locks after the threshold.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C09 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
