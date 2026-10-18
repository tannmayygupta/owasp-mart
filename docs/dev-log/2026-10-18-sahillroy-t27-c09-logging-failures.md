# T-27 C09 Logging and Alerting Failures (legacy login route not logged)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-challenges-c09-c11 story 7.1 |

## Requirements covered
FR-CHL-10 (C09). Challenge spec C09.

## Summary (plain language, 3-5 lines)
Gave the shop's web login a security pipeline — every attempt is written to the `security_events` log and the account locks after 5 tries with an alert — and added a legacy mobile login that, in the vulnerable build, skips that pipeline entirely (no event, no lockout, no rate limit). A slow brute force against the dormant support agent on the legacy route is invisible and never locks, and the obtained session reads the break-glass flag in the support case notes. The fixed build routes the legacy login through the same pipeline. An exploit test proves both.

## Why
FR-CHL-10 / C09. One auth route missing from the security-event pipeline, with no lockout, is a classic logging/alerting failure (A09).

## What was built
- `c09-logging-failures.mjs`: `recordAuth` (write a security event + alert on threshold), `isLocked`, the legacy login route (both branches), and the case-note reference (flag).
- Web login (`routes.mjs`) now checks the lockout and records every attempt.
- Legacy route `/m/api/v1/login` (JSON API, before checkCsrf).
- Support case-notes page `/support/cases/notes` (support/admin; the flag).

## How it works
`recordAuth` writes to the shop's own `security_events` table and raises an `alerts` row after 5 failures in 5 minutes; `isLocked` reads the same window. The web login always uses it; the legacy route uses it only on the fixed build. The C09 proof reads the `security_events` table (zero rows for the account after a legacy attack).

## Files changed
- `apps/shop/src/challenges/c09-logging-failures.mjs` — new.
- `apps/shop/src/web/routes.mjs`, `apps/shop/src/app.mjs`, `apps/shop/src/web/routes-staff.mjs`, `apps/shop/src/views/staff/case-notes.njk`.
- `challenges/tests/c09-logging-failures/{exploit.mjs,c09.test.mjs}` — new.

## Decisions made
- The IF-4 platform event `shop.security_event_written` is NOT emitted yet: the posted event schema (IF-4, stream L) does not list it, and emitting it would fail the posted-schema validation the T-10 harness enforces. The shop-side proof is the `security_events` table; the platform event is deferred to the IF-4 schema addition (recorded in deferred-work).

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 30 pass (C09 3/3). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass. No new migration (uses the existing `security_events`/`alerts` + `sentinel`).

## Security notes (vulnerable parts only)
The vulnerable branch leaves the legacy route out of the security pipeline — no event, no lockout, no rate limit (CWE-778/307), isolated in `c09-logging-failures.mjs`, off by default. The fix is one shared auth pipeline for all channels. C07 failures are logged normally, so C09 counts legacy failures only; the player cannot read or write `security_events`.
