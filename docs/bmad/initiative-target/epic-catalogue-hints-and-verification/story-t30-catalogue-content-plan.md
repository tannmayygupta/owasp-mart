---
title: 'Catalogue content: tags, tiers, briefs, hints, write-ups and decoy locations'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: 'built'
baseline_revision: '1d0e0d7'
route: 'full'
risk: 'low'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
  - '{project-root}/contracts/catalog/challenge.schema.json'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-CHL-01/14/15/17 need the IF-7 catalogue filled for all 11 challenges — tags and tier, a flag-free brief, the three hint levels, the milestone detection signals, the write-up and the decoy locations — so the platform/lab can show each challenge page.

**Approach:** Extend the IF-7 schema additively (optional `brief`, `write_up` {vulnerable, fix}, `decoys`), then fill every `challenges/catalog/cNN.yaml` to `status: complete` from `docs/design/challenge-specs.md`. The `exploit_test`/`fixed_build` fields stay logical references (schema stable); the README records the real self-test folders (`cNN-<name>`) and the `VM_CHALLENGE_<KEY>` build-flag model. The validator now requires a `complete` entry to have non-null signals/hints and a brief.

## Boundaries & Constraints

**Always:** A brief never contains a flag. The schema change is additive (new optional fields) — not breaking; `exploit_test`/`fixed_build` patterns unchanged. IF-7 bumps to 1.1.0.

**Never:** No real flag value in the catalogue. No breaking contract change (that would need consumer approval).

## Code Map

- `contracts/catalog/challenge.schema.json` — `brief`, `write_up`, `decoys` (optional); IF-7 1.1.0.
- `challenges/catalog/c01..c11.yaml` — all `status: complete`.
- `challenges/catalog/README.md` — the exploit_test/fixed_build real-folder + build-flag note.
- `scripts/validate-catalog.mjs` — complete-status content checks.
- `contracts/CHANGELOG.md` — IF-7 1.1.0 entry.

## Tasks & Acceptance

- [x] Schema fields, 11 catalogue entries filled, validator complete-checks, IF-7 changelog.

**Acceptance:** every entry shows its tags, tier and a flag-free brief; the three hints and milestone signals are filled; the catalogue validates; contract-rules pass.

## Verification

- `node scripts/validate-catalog.mjs` — all 11 complete + valid.
- `node --test scripts/validate-catalog.test.mjs` — 13/13.
- `node scripts/check-contract-rules.mjs` — 18 PASS, 0 FAIL.
