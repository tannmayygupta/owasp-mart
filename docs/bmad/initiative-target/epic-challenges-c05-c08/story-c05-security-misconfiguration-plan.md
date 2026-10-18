---
title: 'C05 Security Misconfiguration (unauthenticated diagnostics page)'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: 'built'
baseline_revision: '649bc16'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C05 (OWASP A05, CWE-489/209) needs two shipped misconfigurations: an ops console left on with no login, and a verbose error handler that leaks internal paths.

**Approach:** A challenge module mounts `/_ops/` and `/_ops/diagnostics` and a `POST /api/cart` verbose-error endpoint, all before the CSRF middleware (anonymous; the probe posts raw JSON). Vulnerable build: `/_ops/*` serve a hand-built synthetic diagnostics object whose `support_bridge_token` is the flag, and broken JSON returns a stack trace naming an internal `_ops` file. Fixed (default) build: `/_ops/*` are 404 and a broken request gets a generic error with a correlation id.

## Boundaries & Constraints

**Always:** Default to fixed. The diagnostics object is hand-built from synthetic values plus the one injected flag — never `process.env`, a database URL, a session secret, the instance key or dependency versions. Emit `shop.verbose_error` and `ops.page_served`.

**Never:** No real secret in the dump (host-safety rule; no overlap with C06/C10/C11). No debug route in the fixed build.

## I/O & Edge-Case Matrix

| Build | Request | Result |
|-------|---------|--------|
| vulnerable | `POST /api/cart` broken JSON | 500 + stack naming `_ops` + `shop.verbose_error` |
| vulnerable | `GET /_ops/diagnostics` | 200 + `support_bridge_token` (flag) + `ops.page_served` |
| fixed | `POST /api/cart` broken JSON | 400 generic + correlation id, no stack |
| fixed | `GET /_ops/*` | 404, no event |
| either | `POST /api/cart` valid JSON | 200 |

</frozen-after-approval>

## Code Map

- `apps/shop/src/challenges/c05-ops-console.mjs` — ops routes + verbose-error endpoint + synthetic diagnostics.
- `apps/shop/src/app.mjs` — `registerOpsRoutes` mounted before `checkCsrf`.
- `challenges/tests/c05-security-misconfig/{exploit.mjs,c05.test.mjs}`.

## Tasks & Acceptance

- [x] Ops console + verbose error (both build-gated), synthetic diagnostics, exploit + self-test.

**Acceptance:** broken JSON leaks an `_ops` trace and `/_ops/diagnostics` serves the flag on the vulnerable build; both are generic/404 on the fixed build; no real data in the dump.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C05 2/2.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
