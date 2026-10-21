---
title: 'Cross-challenge tests and exploit tests as a CI release gate'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'done'
baseline_revision: 'b3ca943'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-CHL-13/16 need the 11 exploit tests run as a release gate (a failing one blocks a release) and cross-challenge independence (solving one challenge captures no other flag).

**Approach:** A `release-gate.mjs` that runs every challenge's self-test (each boots the real shop in the vulnerable and the fixed build and asserts the exploit passes on the former and fails on the latter) and exits non-zero on any failure. The existing `exploit runner` CI job already runs all challenge self-tests, so a failing exploit blocks the release. An `independence.test.mjs` adds the structural guarantee: no challenge module reads another challenge's sentinel flag, the sentinel keys are distinct, and the gate covers all eleven challenges.

## Boundaries & Constraints

**Always:** Node built-ins only; the gate discovers the `cNN-*` self-test folders. Each challenge keys its flag to its own source (distinct sentinel key or an own-path-only field).

**Never:** No release passes with a fixed build still exploitable (a self-test failing on the fixed side fails the gate).

## Code Map

- `scripts/release-gate.mjs` — runs the 11 challenge self-tests; per-challenge PASS/FAIL + blocks on failure.
- `challenges/tests/independence.test.mjs` — distinct sentinel keys, no cross-flag reads, gate covers C01–C11.

## Tasks & Acceptance

- [x] Release-gate runner + independence test.

**Acceptance:** `node scripts/release-gate.mjs` reports 11/11 and exits 0 when every challenge is exploitable-on-vulnerable and safe-on-fixed, and non-zero if any regresses; the independence tests pass. The `exploit runner` CI job enforces the same via `node --test challenges/tests/**`.

## Verification

- `node scripts/release-gate.mjs` — 11/11 PASS.
- `node --test challenges/tests/independence.test.mjs` — 2/2.
