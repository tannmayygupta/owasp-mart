---
title: 'In-process loop test: instance, signed events, milestones, attempt clock and score in one pytest'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/prd/PRD.md', '{project-root}/docs/design/challenge-specs.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** Each library has its own tests, but nothing proves that they work together in the order a real assessment uses them. The demo needs a fast, repeatable proof that does not depend on Docker, and CI needs the same guard against someone breaking the seams (an event key that does not match, a score that ignores a held capture, a clock that does not start at ready).

**Approach:** `apps/api/tests/test_lab_loop.py` (new, plus a small helper `apps/api/tests/lab_loop_support.py`) builds `LabRuntime` (story 1) with `FakeInstanceHost`, a `FakeClock`-backed `OffsetClock` and a catalogue of the real 11 weights, then runs the scenarios below through the same objects the demo routes call. Events are signed with `vulnmart.ingest.verify.sign_body` using the event key the runtime's `KeyPort` derives for that instance and epoch, and posted through the real `IngestHandler.handle` with real headers. Expected scores are written in the test as plain numbers worked out by hand from PRD Appendix A (for example C01 Easy weight 60 at M3 is 60 of 960, shown 63 when it is the only capture: 1000 x 60 / 960 = 62.5, rounded half up to 63; write each hand calculation in a comment beside the number).

Scenarios (each a test):
1. **Happy path:** start attempt; fake host reaches ready; the clock starts at ready (`started_at` = ready time, not request time); a signed event for C01 milestone M1 credits M1; a pasted correct flag credits M3; the score shown equals the hand number; learner-style progress shows the tick.
2. **Hint cost:** unlock levels 1 and 2 on C01 first (cumulative 30 percent): per-challenge points drop by the hand value, never below zero.
3. **Held capture:** an event the activity rule marks inconsistent is held; the score excludes it and `held` is true; after `keep` or `release` (story 7.6 when built, else the test calls `MilestoneStore.hold` and the fact directly) the score is recomputed.
4. **Wrong flag, decoy, replay, forgery:** a wrong flag costs nothing; a decoy raises an integrity flag and costs nothing; the same event twice gives one credit; a forged signature and a wrong epoch are refused and change nothing.
5. **Expiry:** advance the clock to deadline minus 5 minutes (one warning event), to the deadline (expired then submitted, `submitted_at` = deadline, access `frozen`), to +14 minutes (instance still there), to +15 minutes (destroyed); a late tick gives the same final state as ticks every 15 s (run both).
6. **Manual submit and reset:** manual submit freezes and destroys the same way; reset (when story 7.5 is built) keeps milestones and the deadline, else the scenario is skipped with a stated reason.
7. **No leak:** serialise every answer of the runtime (state, score, log, events) and assert no flag value, digest, event key or master key appears (the test knows the values it generated).

**Proposed (decided on the developer's delegation):**
- **D-97 (part):** the loop test is the CI-safe layer of the end-to-end suite: no Docker, no network, fake clock, under 10 seconds. The Docker layer (story 3) proves the same loop with real containers; the live layer on the deployed site is the developer's runbook (story 6).

## Boundaries & Constraints

**Always:** expected values are numbers computed by hand in comments, never obtained by calling the scoring code; the test uses the runtime's public methods and the real ingest handler, not private fields; no sleeping (the fake clock moves); every generated secret stays in the test process; assertion messages hold ids and numbers only.

**Never:** a real Docker, orchestrator, database or network; editing production code to make the test pass (a seam that fails is a defect to report to the owning story); contracts, error codes; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clock start | request at T, ready at T+40 s | `started_at` T+40 s, deadline T+40 s + 120 min | none |
| Only C01 at M3 | no hints | shown 63 | none |
| C01 at M3 with two hints | 30 percent cost | points 60 x 0.70 = 42 of 960, shown 44 (half-up of 43.75) | none |
| Held C02 | held milestone | excluded, `held` true | none |
| Replay | same event twice | one credit, second answered as replay | none |
| Forgery | wrong signature | refused, nothing stored | IF-4 problem body |
| Late tick | scheduler down 3 hours | one tick reaches `submitted`, frozen and destroyed in the same tick (D-83) | none |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/lab/runtime.py` (story 1), `ingest/handler.py`, `ingest/verify.py` (`sign_body`), `ingest/engine.py`, `flags/submit.py`, `ports/fake_instance_host.py`, `ports/engine_attempts.py`, `ports/engine_reports.py`.
- `packages/py-attempts/tests/conftest_engine.py` -- fake clock helper pattern; `apps/api/tests/ingest_support.py`, `ingest_wire_support.py` -- how existing tests build signed events (reuse, do not copy).
- New: `apps/api/tests/test_lab_loop.py`, `lab_loop_support.py`.
- docs: dev-log, CHANGELOG, traceability LX-1 (local layer), evidence `docs/assets/story-8-2-loop-test/` (the pytest output), no handoff.

## Tasks & Acceptance

**Execution:**
- [ ] `lab_loop_support.py` (runtime builder, event signer, hand-score table) and the seven scenarios
- [ ] run twice to check determinism; record the real output and the run time
- [ ] add the file to the default `pytest` run (it lives under `apps/api/tests`, so `testpaths` already finds it)
- [ ] docs -- dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given the runtime on fake components, then all seven scenarios pass in under 10 seconds and give the same result twice.
- Given a broken seam (for example a wrong event key), then the happy-path test fails with a message naming the step.
- Given the full output, then no flag, key or digest value appears in it.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_lab_loop.py`
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests` (whole suite, expected: pass)
- `node scripts/check-text-files.mjs`, `node scripts/scan-flags.mjs`, `node scripts/scan-secrets.mjs`
