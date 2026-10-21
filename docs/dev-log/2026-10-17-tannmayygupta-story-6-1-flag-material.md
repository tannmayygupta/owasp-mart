# Flag material and checker: derive per instance and epoch, decoys, verify by recomputing, leak scan (story 6.1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: material builder, checker and leak scan built and their tests passed locally; the real InstancePort does not call them yet, the real KeyPort does not exist yet |
| Report tag | flag material, flag checker, leak scan, FR-FLG-01, FR-FLG-02, FR-FLG-03, FR-FLG-07, FR-FLG-08, D-71, D-72, D-79 |

## Requirements covered
FR-FLG-01, 02, 03, 07, 08 (FR-FLG-07 half met, see limitations), D-02, D-23; decisions D-71, D-72, D-79 (new, Proposed, in ADR 0092); handoffs H-63 (partly answered), H-330, H-331 (new). Task L-19 (stays unticked).

## Summary (plain language, 3-5 lines)
The platform can now build the flag material of a create or reset (one flag per challenge, two decoys each, digests of the real flags, the event key and a seed) using only the KeyPort interface, and can classify a candidate text as correct, decoy, stale epoch, other instance or wrong by recomputing the expected flag. A new scan script looks for the flag pattern in image layers, container logs, `docker inspect` output and a text file. No flag table exists and no flag value is printed anywhere.

## Why
The orchestrator already injected whatever flags it was given, but nothing on the platform side built them, classified a candidate or proved that no flag pattern leaks into an image layer, a log or `docker inspect`. Handoff H-63.

## What was built
- `apps/api/src/vulnmart/flags/material.py`: `build_material`, `DECOY_PLACEMENT`, `sha256_hex`, constants. Optional `seed` for tests.
- `apps/api/src/vulnmart/flags/checker.py`: `FlagChecker.classify`, `FlagClass`, `FlagCheck`, `candidate_digest`; constant-time compare (`hmac.compare_digest` on SHA-256 hex), epochs 1..current walked, hash-only entry for the sidecar's `candidate_sha256`.
- `scripts/scan-flags.mjs` and `scripts/scan-flags.test.mjs`: layer, log, inspect and file scan; the documented fake pattern is allowed; values are never printed.
- Tests: `apps/api/tests/test_flags_material.py`, `test_flags_checker.py`.

## How it works
Flags come only from the `KeyPort` methods `flag`, `decoy`, `event_key`; the code never reads the master key and never imports the fake (a test greps for it). A decoy never equals a real flag of the same instance and epoch. Classification order: correct, decoy, stale epoch, other instance, wrong; every candidate value is compared without an early exit. Dataclasses hide secret fields from `repr`. The scan reads layer tar entries as bytes and also looks for the encoded forms the event contract refuses.

## Files changed
- `apps/api/src/vulnmart/flags/{material,checker}.py` - new
- `apps/api/tests/{test_flags_material,test_flags_checker}.py` - new
- `scripts/scan-flags.mjs`, `scripts/scan-flags.test.mjs` - new
- `docs/assets/story-6-1-flag-material/test-output.txt`
- Docs: this entry, ADR 0092, `initial.md` (D-71, D-72, D-79), HANDOFFS, CHANGELOG, traceability, dev1 file

## Decisions made
D-71 (where the detection code lives: `apps/api/src/vulnmart/flags/` and `ingest/`, pure functions and Protocols), D-72 (flag rules: format unchanged, two decoys per challenge, digests of real flags only, verification always a recompute), D-79 (fake KeyPort only through the composition root). See `docs/adr/0092-flags-sidecar-and-milestone-decisions.md`. Decisions inside the plan: `build_material` returns the decoy values only (IF-5 `FlagMaterial` has no field for placement text) and `DECOY_PLACEMENT` is a module table; the real-Docker scan case is in the Node test, not in `apps/orchestrator/tests`; `scan-flags.mjs` with no arguments prints "nothing to scan" and exits 0.

## Tests
Raw output in `docs/assets/story-6-1-flag-material/test-output.txt`.
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_flags_material.py apps/api/tests/test_flags_checker.py`: 39 passed.
- `uv run --locked --package vulnmart-api pytest -q` (whole api suite): 1012 passed, 7 skipped (the Postgres tests need DSNs).
- `node --test scripts/scan-flags.test.mjs`: 11 passed, 0 skipped (Docker Desktop was running; the real-Docker case scanned a `vulnmart-stub-instance:local` container's layers, logs and inspect output: clean passes, a planted env value fails in inspect, a planted log line fails in logs, values never printed).
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: pass. New files checked by hand for CR, BOM and control characters: none.
- NOT run: `node scripts/check-contract-rules.mjs` and the orchestrator Docker suite (nothing there changed).
Traceability rows: FR-FLG-01, 02, 03, 07, 08, D-02, D-23.

## Evidence
`docs/assets/story-6-1-flag-material/test-output.txt`.

## Problems met and how they were fixed
None recorded in the plan notes.

## Security notes (vulnerable parts only)
Not a vulnerable part of the shop; this is the platform's flag handling. The master key never enters an instance; flags are derived per instance and epoch. No flag value, digest of a real flag or key appears in a log line, exception text or test message; tests use the documented fake pattern only.

## Limitations and follow-ups
- Decoy placement has no field in IF-5 `FlagMaterial` and the catalogue (IF-7) has no decoy location list: until Sahil's T-30 adds one, default texts are used and the injector decides where a decoy goes. Decoys may not be placed in the shop on the 19th (FR-FLG-07 half met); credit logic is unaffected (H-331).
- A full instance made through the orchestrator code was not scanned (`--instance <id>` plus the orchestrator log with `--file`): left to the integration step or the runbook step in `docs/runbooks/deploy.md`, not written yet.
- The same scan on `vm-i` against released digests is a developer runbook step (not run).
- The real KeyPort (P-17) replaces the fake with no change to this code; until then the composition root passes `FakeKeyPort`.
