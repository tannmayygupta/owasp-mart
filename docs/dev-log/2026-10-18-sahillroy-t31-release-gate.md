# T-31 Cross-challenge tests and exploit tests as a CI release gate

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-catalogue-hints-and-verification story 8.2 |

## Requirements covered
FR-CHL-13 (exploit tests as a release gate), FR-CHL-16 (cross-challenge independence).

## Summary (plain language, 3-5 lines)
Added a release gate that runs all 11 challenge exploit self-tests — each proves its weakness is exploitable on the vulnerable build and NOT on the fixed build — and blocks a release if any fails. Added a cross-challenge independence test: no challenge module reads another's sentinel flag, the sentinel keys are distinct, and the gate covers every challenge. The existing exploit-runner CI job already runs all these self-tests, so a failing exploit blocks the release.

## What was built
- `scripts/release-gate.mjs`: discovers the `cNN-*` self-test folders, runs each, prints a per-challenge PASS/FAIL table, and exits non-zero on any failure.
- `challenges/tests/independence.test.mjs`: asserts each challenge module reads only its own sentinel key, the keys are distinct, and the gate lists C01–C11.

## How it works
Each `cNN.test.mjs` boots the real shop in the vulnerable and the fixed build and asserts pass-then-fail. The release gate runs them all; a fixed build that is still exploitable (or a broken exploit) fails its self-test and the gate. Independence is guaranteed structurally (distinct flag sources, no cross-reads) on top of each self-test proving the exploit reads only its own marker.

## Files changed
- `scripts/release-gate.mjs`, `challenges/tests/independence.test.mjs` — new.

## Tests
`node scripts/release-gate.mjs` — 11/11 PASS (C01–C11 all exploitable-on-vulnerable, safe-on-fixed). `node --test challenges/tests/independence.test.mjs` — 2/2.

## Decisions made
- The release gate is enforced in CI by the existing `exploit runner` job (`node --test challenges/tests/**`); `release-gate.mjs` is the explicit, human-readable gate for local use and clarity.

## Security notes (vulnerable parts only)
This story is verification only — it runs the existing challenge self-tests. The independence guarantee (each flag reachable only by its own challenge) is the point: the structural test plus each self-test (exploit reads only its own marker; fixed build not exploitable) together prove solving one challenge captures no other flag.
