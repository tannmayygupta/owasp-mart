---
title: 'Flag material and checker: derive per instance and epoch, decoys, verify by recomputing, leak scan'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/04-data-and-state.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The derivation functions exist (`derive_flag`, `FakeKeyPort`, H-21) and the orchestrator already injects whatever flags it is given (`injection_document`, `sidecar_document`), but nothing on the platform side builds the flag material of a create or reset, nothing classifies a candidate flag (correct, decoy, stale, other instance), and nothing proves that no flag pattern reaches an image layer, a log or `docker inspect`. FR-FLG-01, 02, 03, 07, 08 are therefore not met. Handoff H-63.

**Approach:** (1) `apps/api/src/vulnmart/flags/material.py`: `build_material(keys, instance_id, epoch, challenge_keys, ...)` returns the IF-5 `FlagMaterial` (flags, decoys with a placement text, digests of the real flags, event key, seed) using only the `KeyPort` Protocol, so the fake and the real KeyPort are interchangeable. (2) `apps/api/src/vulnmart/flags/checker.py`: `FlagChecker.classify(...)` recomputes the expected flag and compares in constant time (`hmac.compare_digest` on SHA-256 digests); there is no flag table; results `correct`, `decoy`, `stale_epoch`, `other_instance`, `wrong`. (3) `scripts/scan-flags.mjs`: a leak scan over `docker save` layers, container logs, `docker inspect` output and a text file (the orchestrator log), plus a local test against a real instance made by the orchestrator. Decided on the developer's delegation: D-71 (where the code lives), D-72 (material and checker rules), D-79 (fake KeyPort only through the composition root). All Proposed; the main session records them.

## Boundaries & Constraints

**Always:**
- Derive only through the `KeyPort` methods `flag`, `decoy`, `event_key`; never read `K_flag` or import the key constants. The code in `flags/` imports `vulnmart.ports.keys` (Protocol) and not `vulnmart.ports.fakes`; only tests and the composition root import the fake (D-79). A test greps the package for `fakes` and `FAKE_`.
- Material for a create: one flag per challenge key given (1 to 11), `decoys_per_challenge` decoys each (default 2, 0 to 4, index 0..n-1), `flag_digests` of the real flags only (the orchestrator adds the decoy digests itself, `builder.sidecar_document`), the event key of `(instance, epoch)` and a seed of 43 URL-safe characters from `secrets.token_urlsafe(32)` (the seed is random per call, the only random element; a reset passes a fresh one). A reset builds the same shape with `epoch + 1`.
- A decoy never equals a real flag of the same instance and epoch (checked at build; the derivation labels differ, the check is a guard). Decoy placement text comes from a default table `DECOY_PLACEMENT` (one line per challenge, plain words, no flag) until the catalogue carries decoy locations (handoff to Sahil, T-30); the text is the optional `decoy_placement` of the injection document, but IF-5 `FlagMaterial` has no field for it today: if IF-5 cannot carry it, the table lives in the injector's catalogue read (Sahil) and `build_material` returns the decoy values only. The plan does not change IF-5; see Open.
- Classification order for a candidate text and a context (instance id, current epoch, challenge key or none, the list of other instances to test): (1) hash equal to a real flag of this instance and the current epoch: `correct`; (2) equal to a decoy of this instance and epoch: `decoy`; (3) equal to a real flag or decoy of this instance at an earlier epoch: `stale_epoch` (the checker tries epochs 1..current, at most 50); (4) equal to a flag of another instance in the given list: `other_instance` and the id of that instance; (5) otherwise `wrong`. All compares use `hmac.compare_digest` on SHA-256 hex digests. The checker also takes a candidate that is only a SHA-256 (the sidecar's `candidate_sha256`) and returns the same classes; the text path hashes first.
- No log line, exception text, `repr` or test failure message holds a flag, a digest of a real flag or the key. Dataclasses hide secret fields (`repr=False`) as `CreateRequest` does (`instance_host.py:101-130`).
- The leak scan reads layer tar entries as bytes and looks for `VM{` followed by 24 Base32 characters, also the forms the event contract refuses (`VM%7B`, full-width brace, lower case), and ignores only the documented fake pattern (`^VM\{([A-Z2-7])\1{23}\}$`, as `scripts/validate-contracts.mjs:23`). The scan prints file and layer names and counts, never the match.

**Never:**
- Editing `apps/api/pyproject.toml`, migrations, the orchestrator, IF-5, IF-6, IF-4 or any contract file; Akshay's non-port API code; `.github/workflows/**`; the Excel tracker; pushes and commits; git checkout, stash or reset; AWS, ssh, terraform.
- A flag table, a stored candidate, a flag in an environment variable or in a label.
- Deciding the real KeyPort's key storage (Akshay, P-17).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two instances | same template, ids A and B, epoch 1 | every flag differs between A and B; digests differ | none |
| Reset | A at epoch 1 then epoch 2 | all flags and decoys differ from epoch 1; event key differs; checker says `stale_epoch` for an epoch-1 flag, `correct` for the new one | none |
| Decoy | candidate equals decoy 1 of C05 | `decoy`, challenge C05 | none |
| Other instance | candidate is B's flag, checked on A with B in the list | `other_instance` naming B | none |
| Wrong | random flag-shaped text | `wrong` | none |
| Hash only | `candidate_sha256` of the real flag | `correct` | none |
| Constant time | a test replaces the compare with a spy | only `compare_digest` is called | n/a |
| Bad input | challenge key `C12`, epoch 0, 0 or 12 challenges, 5 decoys | `ValueError` with a fixed message that holds no secret | callers map to 422 |
| Scan clean | real local instance, 2 challenges | scan exit 0, prints counts | none |
| Scan finds | layer or log with a planted real-pattern flag | exit 1, names where, never prints the value | none |
| Docker missing | no daemon | the real-Docker scan test skips | none |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/ports/keys.py:63-71` (`derive_flag`), `:115-129` (`KeyPort` Protocol) and `apps/api/src/vulnmart/ports/fakes.py:120-183` (`FakeKeyPort`) -- read only; the derivation and the fake exist (H-21 answered by Akshay).
- `apps/api/src/vulnmart/ports/instance_host.py:82-130` (`FlagEntry`, `DecoyEntry`, `DigestEntry`, `FlagMaterial`) -- the shape `build_material` returns; stream L owns the InstanceHost client.
- `apps/api/src/vulnmart/flags/__init__.py` -- the stream L folder (docstring says so; table `flag_submissions` is owned here in `contracts/db/table-owners.yaml:44`); new files `material.py`, `checker.py` here.
- `apps/orchestrator/src/vulnmart_orchestrator/builder.py:140-167` (`_parse_material`), `:484-502` (`injection_document`, `sidecar_document`) and `engine.py:426,438-439` -- read only: the orchestrator receives and injects the material; the digests go to the sidecar and not to the injector (H-63).
- `scripts/scan-flags.mjs` (new) and `scripts/scan-flags.test.mjs` (new); pattern precedent `scripts/harness.test.mjs:176`, `scripts/validate-contracts.mjs:23-24`, `scripts/scan-secrets.mjs`.
- `apps/orchestrator/tests/test_docker_integration.py` -- real-Docker tests; the scan test follows its skip-without-daemon pattern and its stub-instance image build.
- `contracts/mocks/stub-instance/inject.mjs` -- the stub injector that writes `/run/vm/flags.json`; the local scan runs against instances made from it.
- Tests: `apps/api/tests/test_flags_material.py`, `apps/api/tests/test_flags_checker.py` (new).
- Docs: dev-log, CHANGELOG, traceability (FR-FLG-01, 02, 03, 07, 08, D-02, D-23), HANDOFFS (H-63 answer; new rows H-127 and H-128 below), evidence `docs/assets/story-6-1-flag-material/`.

## Tasks & Acceptance

**Execution:**
- [ ] `flags/material.py` -- `build_material`, `DECOY_PLACEMENT`, validation, secrets hidden from repr
- [ ] `flags/checker.py` -- `FlagChecker`, five classes, hash-only entry, constant-time compare, epoch walk
- [ ] `apps/api/tests/test_flags_material.py`, `test_flags_checker.py` -- every matrix row; the no-fake-import test; a fuzz of 200 random candidates never classed `correct`
- [ ] `scripts/scan-flags.mjs` and test -- `docker save` layer scan, `docker logs`, `docker inspect`, text file scan; planted-pattern failure test; documented fake pattern allowed
- [ ] real-Docker test: make a 2-challenge instance with the stub-instance image through the orchestrator code with `FakeKeyPort` material, run the scan on layers (of the images used), every container's logs, `docker inspect` of every container and the orchestrator's captured log; expect clean
- [ ] docs and handoff rows as in the Code Map

**Acceptance Criteria:**
- Given two instances of the same template, then no flag, decoy or event key is equal.
- Given a reset, then the old flags classify as `stale_epoch` and the new as `correct`, and the old event key differs from the new.
- Given a decoy or another instance's flag, then the class is `decoy` or `other_instance` and never `correct`.
- Given a real local instance, then `node scripts/scan-flags.mjs --instance <id>` finds no flag pattern in layers, logs, inspect output or the orchestrator log, and fails on a planted one.

## Verification

**Commands (Windows dev PC, Docker Desktop running for the last two):**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_flags_material.py apps/api/tests/test_flags_checker.py` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass (nothing else changed)
- `node --test scripts/scan-flags.test.mjs` -- expected: pass (planted pattern fails, fake pattern passes; the real-Docker case skips without a daemon)
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests/test_docker_integration.py` -- expected: pass, with the new scan case
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/check-contract-rules.mjs` -- expected: pass

**Local only / developer runbook (not provable here):** the same scan against the images on `vm-i` and a live instance (`docker save` of the released digests, `docker logs` there): a numbered step in `docs/runbooks/deploy.md`; the real KeyPort (P-17) replaces the fake with no change to this code.

## Proposed (decided on the developer's delegation)

- **D-71 Where platform-side detection code lives.** No new package. Flag code is in `apps/api/src/vulnmart/flags/` and the milestone, evidence and activity code in `apps/api/src/vulnmart/ingest/` (both folders are stream L's by their docstrings and by `contracts/db/table-owners.yaml`). Pure functions and Protocols, no database import, so they run in plain pytest and Akshay's ingest worker and routes call them.
- **D-72 Flag rules.** Format unchanged (`VM{` + 24 Base32 characters + `}`; a CI-scannable pattern). Two decoys per challenge by default. Digests of real flags only in IF-5. Classification order as above. Verification is always a recompute; the key never enters an instance.
- **D-79 Fake KeyPort.** Until Akshay's real KeyPort lands (P-17), the composition root passes `FakeKeyPort`; library code takes the Protocol only; a test fails if library code imports the fake.

## Open (not settled here)

- Decoy placement has no field in IF-5 `FlagMaterial` and the catalogue (IF-7) has no decoy location list: until Sahil's T-30 adds one, default texts are used and the injector decides where a decoy goes. Risk for the 19th: decoys may not be placed in the shop (FR-FLG-07 half met); credit logic is unaffected.

## Implementation Notes

Built 2026-10-17 (implementer run; not yet reviewed, not committed).

**Files:** `apps/api/src/vulnmart/flags/material.py` (`build_material`, `DECOY_PLACEMENT`, `sha256_hex`, constants), `apps/api/src/vulnmart/flags/checker.py` (`FlagChecker.classify`, `FlagClass`, `FlagCheck`, `candidate_digest`), `apps/api/tests/test_flags_material.py`, `apps/api/tests/test_flags_checker.py`, `scripts/scan-flags.mjs`, `scripts/scan-flags.test.mjs`, evidence `docs/assets/story-6-1-flag-material/test-output.txt`.

**Real results (raw output in the evidence file):**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_flags_material.py apps/api/tests/test_flags_checker.py`: 39 passed.
- `uv run --locked --package vulnmart-api pytest -q` (whole api suite): 1012 passed, 7 skipped (the Postgres tests need DSNs).
- `node --test scripts/scan-flags.test.mjs`: 11 passed, 0 skipped (Docker Desktop was running; the real-Docker case ran `docker create`/`run` of `vulnmart-stub-instance:local` with the instance label, scanned its layers, logs and inspect output: clean passes, a planted env value fails in inspect, a planted log line fails in logs, values never printed).
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: pass. New files checked by hand for CR, BOM and control characters: none.

**Decisions taken inside the plan's room (report to the main session):**
1. Decoy placement: IF-5 has no field, so `build_material` returns the decoy values only; `DECOY_PLACEMENT` is a module table (one line per C01 to C11) for the injector or catalogue read.
2. `build_material` takes an optional `seed` (default `secrets.token_urlsafe(32)`) so tests can pin it; the checker takes `decoys_per_challenge` (default 2, must equal the one used at build).
3. `classify` takes `other_instances` as a list (epochs 1..this epoch tried) or a mapping instance id to current epoch. It compares every candidate value without an early exit; `other_instance` is checked only after `correct`, `decoy` and `stale_epoch`.
4. The real-Docker scan case is in the Node test (`scripts/scan-flags.test.mjs`), not in `apps/orchestrator/tests/test_docker_integration.py`, because this run may not touch apps/orchestrator. It does not create an instance through the orchestrator code; a full orchestrator-made instance scan (`--instance <id>` plus the orchestrator log with `--file`) is left to the main session or the runbook step.
5. `scan-flags.mjs` with no arguments prints "nothing to scan" and exits 0 (the Coraza plan calls it without arguments); exit 2 for bad usage or a failed step.

**Not done / open:** the planned `docs/runbooks/deploy.md` step, HANDOFFS rows and the other documentation are the main session's. `node scripts/check-contract-rules.mjs` and the orchestrator Docker suite were not run (nothing there changed).