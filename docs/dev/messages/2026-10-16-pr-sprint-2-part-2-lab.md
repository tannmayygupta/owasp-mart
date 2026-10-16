# Pull request text: Sprint 2 part 2, stream L (reset, reconciler, isolation, quotas)

Branch `sprint-2-tanmay-b` into `main`. Written 2026-10-16 by Tanmay's Claude session. Not pushed.

## Title

Sprint 2 part 2 (Tanmay, stream L): reset and teardown, reconciler, release loader, isolation probe, socket proxy, quotas

## Description

Finishes my Sprint 2 tasks on the code side (L-14 to L-16). Six BMAD stories, each with a plan, a review and a dev-log. Nothing was run on AWS or vm-i: the live steps are runbook steps for the developer.

| Story | Task | What |
|---|---|---|
| 3.4 | L-14 | Reset (epoch+1, new flags, old epoch removed first), reaper for the total limit and inactivity, timing settings port (ADR 0035, D-54) |
| 3.5 | L-14 | Reconciler: label scan, adoption of complete instances, failed and swept half-built ones, tombstones, safe mode, startup gate (ADR 0036, D-55) |
| 3.7 | L-12/L-13 | Release manifest loader: the orchestrator accepts `release.json` with per-role healthchecks (D-56) |
| 4.1 | L-15 | Isolation probe from inside a real instance network, stronger conformance rules, VM-I runbook (S-3, S-15; ADR 0037, D-57) |
| 4.2 | L-15 | Docker socket behind a filtering proxy, compose rule on a real YAML parse (ADR 0010, ADR 0038, D-58) |
| 3.6 | L-16 | Parallel-build cap, one start retry, quotas through the fake QuotaPort, `measure.py --concurrent`, warm pool Proposed (ADR 0039, D-59) |

No contract file changed (`node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL).

## How to verify

- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- 406 passed (real Docker included)
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py apps/api/tests/test_wire_rules.py apps/api/tests/test_http_service.py apps/api/tests/test_reports.py apps/api/tests/test_mtls.py` -- 392 passed, 1 skipped (a test of the Node fake); the 18 reset skips are gone
- `uv run --locked --package vulnmart-api pytest -q` -- 973 passed, 7 skipped (Postgres DSNs)
- `node --test "scripts/*.test.mjs"` -- 763 tests, 760 pass, 2 skipped, 1 fail: `generate-api-code.test.mjs` (a Windows line-ending test, fails the same way on a stash and on Sahil's branch; not touched here)
- `node scripts/isolation-probe.mjs` on Docker Desktop -- PASS (16 forbidden targets blocked, control reached, nothing left)
- Raw outputs: `docs/assets/sprint-2-final-verification/test-output.txt` and the `docs/assets/story-*` folders

## What is NOT done (the developer's live steps)

- vm-i: the S-3 host-rule run (rule on and off), S-15, the socket proxy in front of the orchestrator, the concurrent measurement, the S-4 cold start (runbooks: `isolation-vm-i.md`, `deploy.md` Part E, `measure-instances.md` step 7).
- Decisions D-54 to D-59 and ADRs 0035 to 0039 are Proposed (decided on the developer's delegation) until confirmed.
- L-15 and L-16 are not ticked: their Done-when needs vm-i evidence. L-14 is ticked on the developer's instruction (local proof only).
- Story states are `built`, not `done`.

## For the other streams

- **Akshay** (stream P): H-122 (activity signal and idle destroy: until answered the orchestrator ends an instance `idle_minutes` after ready even while a player works, so send a large `idle_minutes`), H-123 (desired-state list for the reconciler, high transition numbers after an adopted instance), H-125 (live proxy step on vm-i), H-126 (quota numbers, the real `InstancePort`, `QuotaPort.limits()`, a `failed` instance with a pending retry still holds a place).
- **Sahil** (stream T): H-124 (the release file is accepted as is and `CMD` is added by the orchestrator; no change needed on his side). The PR #14 review messages are in this folder.

## Known leftovers

See `docs/bmad/initiative-lab/deferred-work.md` (tombstone append inside the engine lock, no FIFO for waiting builds, adopted idle limit fixed at adoption, a failed reset can only be destroyed, `resetting` to `stopping` not in the IF-5 table, stale comment in `ci.yml`).
