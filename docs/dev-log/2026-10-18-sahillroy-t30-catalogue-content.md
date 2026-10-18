# T-30 Catalogue content: tags, tiers, briefs, hints, write-ups and decoy locations

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-catalogue-hints-and-verification story 8.1 |

## Requirements covered
FR-CHL-01 (catalogue), FR-CHL-14/15/17 (tags/tiers/briefs/hints/write-ups/decoys). Challenge-specs for all 11.

## Summary (plain language, 3-5 lines)
Filled the IF-7 challenge catalogue for all 11 challenges to `status: complete`: milestone detection signals, the three hint texts, a flag-free brief, the vulnerable/fix write-up and the decoy locations, from docs/design/challenge-specs.md. Extended the catalogue schema additively with `brief`, `write_up` and `decoys` (optional), bumping IF-7 to 1.1.0 (not breaking). The `exploit_test`/`fixed_build` fields stay logical references; the README notes the real test folders (cNN-<name>) and the VM_CHALLENGE_<KEY> build-flag model.

## What was built
- Schema: optional `brief`, `write_up` ({vulnerable, fix}), `decoys`; IF-7 1.1.0 changelog entry.
- All 11 `challenges/catalog/cNN.yaml` filled to complete.
- `validate-catalog.mjs`: a complete entry must have non-null milestone signals, non-null hints and a brief.
- `challenges/catalog/README.md`: the exploit_test/fixed_build real-folder + build-flag note.

## Decisions made
- Kept `exploit_test`/`fixed_build` patterns unchanged to avoid a BREAKING IF-7 change (the rules engine flags any pattern change as breaking, which would need Akshay/Tanmay approval). They are logical references; the README maps them to the real cNN-<name> folders and the VM_CHALLENGE_<KEY> flag.

## Files changed
- `contracts/catalog/challenge.schema.json`, `contracts/CHANGELOG.md`, `challenges/catalog/*.yaml`, `challenges/catalog/README.md`, `scripts/validate-catalog.mjs`, `scripts/validate-catalog.test.mjs`.

## Tests
`node scripts/validate-catalog.mjs` -- all 11 complete + valid. `node --test scripts/validate-catalog.test.mjs` -- 13/13. `node scripts/check-contract-rules.mjs` -- 18 PASS, 0 FAIL (IF-7 1.1.0, additive, no mock, not breaking).

## Security notes (vulnerable parts only)
None. Briefs are flag-free (the secret-scan + the FLAG_LIKE catalogue check enforce no VM{...} value in the catalogue).
