---
title: "Refactor sweep"
ticket: 9
status: done
---

# Refactor sweep

**Verify:** deferred review findings are closed or recorded and CI is green. **After:** stories 1.1 to 1.8.

## Scope (set by the developer, 2026-10-20)
"Small fixes + record the rest", and about 14 known limitations accepted as recorded. A read-only triage sorted the 156 items of `deferred-work.md`: 40 already closed by later stories, about 19 small fixes, about 79 decisions (14 of them only to accept), 18 for another stream or deployment. On a closer look K2 (sealing the mail link: 16 test files read it), P5 and Q6 (vendoring a third-party domain list), D4 (an IF-3 contract file) and E2 (IF-1's mock, optional) moved to "recorded".

## Plan
1. CI: `pnpm run web:check` (web typecheck and `apps/web/test`) chained into `api:check`; `scripts/web-lockfile-sync.test.mjs` (A2, B1, B3).
2. `exitCodeProblems` in `scripts/validate-errors.mjs` (C2).
3. Per-account limit on `startMfaEnrolment` (F6) and on invite resends (R5), placeholder settings.
4. Seed-admin audit to the durable log (O7), tested on Postgres.
5. Postgres test of the company stream under row-level security (U5).
6. Consent screen: unticked agree box, Start and Decline (N1).
7. Docs: lost-second-factor runbook (F3); the decline in the architecture diagram (N3); D-98 to D-101 in `initial.md` (N6, O11, P6, R9).
8. Remove the dead `check_password`.
9. Record every item in `deferred-work.md` (fixed, closed with evidence, accepted, another stream, open decision).

**Commands:**
- `.venv/Scripts/python -m pytest apps/api/tests -q` (Postgres and Valkey containers) -- result: 2893 passed, 1 skipped
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"` -- result: 1219 pass, 3 fail (the generator tests; `datamodel-codegen` is not installed locally)
- `pnpm run web:check` -- result: typecheck clean, 18 pass
- `npm run build` in `apps/web` -- result: compiled

**Results (2026-10-20):** evidence `docs/assets/story-1-9-refactor-sweep/`.
