# Concurrency, quotas, start failures and the warm-pool decision (story 3.6)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `1ee5c01` (commit of this story follows) |
| Status | Partly done: built and tested locally; the vm-i numbers (runbook `measure-instances.md` step 7) were not run, they are the developer's; the story waits for the developer's confirmation |
| Report tag | concurrency, quotas, start retry, warm pool, FR-INS-06, FR-INS-08, FR-INS-09, D-59 |

## Requirements covered
FR-INS-06 (quotas), FR-INS-07 (build cap, part of the service), FR-INS-08 (start retry), FR-INS-09 (warm-pool decision), D-59 (new, delegated, to be confirmed), ADR 0039 (Proposed), OI-21 and OI-24 (stay open), handoffs H-66, H-72, H-79 (answered or noted), H-126 (new, for Akshay).

## Summary (plain language, 3-5 lines)
Many instances can now be started at once without overloading Docker: at most four are built together, the rest wait. A start that fails because of Docker or a health check is tried once more before the instance is marked failed. The lab port layer refuses a request over the per-user (1), per-company (5) or global (20) number of live instances. Whether a warm pool is needed is written down as "not for the first release", with the two numbers that would change that.

## Why
Story plan 3.6 (task L-16): FR-INS-06 and FR-INS-08 need these rules, FR-INS-09 asks for a decision, and handoffs H-66, H-72 and H-79 wait for it.

## What was built
- Orchestrator: settings `max_parallel_builds` (default 4, 1 to 64) and `start_retries` (default 1, 0 to 2) with validation; a build slot counter in the engine; the retry loop in `Orchestrator._build`.
- Quotas: `QuotaPort.limits()` and `QuotaLimits`; `FakeQuotaPort` with company and total numbers; enforcement in `FakeInstancePort.request`.
- `measure.py --concurrent N` and the function `concurrent_burst`.
- Docs: ADR 0039, D-59, runbook step 7, handoffs, changelog, traceability, evidence.

## How it works
A create is accepted at once and its slow work goes to a worker. Before the work starts it waits for a free build slot (state stays `requested`); a destroy that arrives during the wait cancels it. If a try ends in `INST-START-FAILED` or `INST-HEALTH-TIMEOUT`, the objects of the try are removed, `failed` is reported, then `provisioning`, and the same plan and the same secrets (only in the worker's memory) are used for the next try. Injection failures, a destroy and a cleanup that did not finish are not retried. The quota check runs in the lab port layer, above `InstanceHost`: it counts instances that are not `destroyed` or `failed`, checks user, company, then platform, and a repeat of an accepted request is answered before any quota check.

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/engine.py` - build cap, retry, `_fail` returns whether the sweep was clean
- `apps/orchestrator/src/vulnmart_orchestrator/lifecycle.py` - two settings
- `apps/orchestrator/src/vulnmart_orchestrator/measure.py` - `--concurrent`
- `apps/orchestrator/tests/test_engine_concurrency.py` (new), `test_measure.py`
- `apps/api/src/vulnmart/ports/quota.py`, `fakes.py`, `lab_fakes.py`; `apps/api/tests/test_ports_lab.py`
- `docs/adr/0039-no-warm-pool-for-the-first-release.md` (new), `initial.md` (D-59), `docs/runbooks/measure-instances.md`, `docs/dev/HANDOFFS.md`, `CHANGELOG.md`, `docs/traceability.md`, the story plan (status `built`)
- `docs/assets/story-3-6-concurrency-quotas/` (local run)

## Decisions made
ADR 0039 (warm pool, Proposed) and D-59. Alternative considered for the retry: a retry in the platform instead of the worker; rejected because only the worker still holds the secrets. Alternative for the cap: a fixed semaphore; a counter that reads the setting each time was used so a setting change applies at once.

## Tests
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 404 passed, 2 warnings (an unclosed HTTP response warning in the Docker integration test, from before this story).
- `uv run --locked --package vulnmart-api pytest -q`: 970 passed, 7 skipped (the Postgres tests need a DSN).
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py apps/api/tests/test_wire_rules.py apps/api/tests/test_http_service.py apps/api/tests/test_reports.py apps/api/tests/test_mtls.py`: 392 passed, 1 skipped (a test of the Node fake).
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL, 1 NOT-APPLICABLE; `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: PASS (after two fixes below).
- Real local run: `uv run --locked --package vulnmart-orchestrator python -m vulnmart_orchestrator.measure --stub-image vulnmart-stub-instance:local --rounds 1 --count 1 --settle 1 --concurrent 3 --out docs/assets/story-3-6-concurrency-quotas`: exit 0, 3 of 3 ready in about 7.6 s, nothing left behind.
- Traceability rows updated: FR-INS-06, FR-INS-08, FR-INS-09.

## Evidence
`docs/assets/story-3-6-concurrency-quotas/measure-concurrent-3-output.txt` and `measure-result.json`. Local only: Windows, Docker Desktop, the two-component stub image. Not a vm-i result and not the real shop image.

## Problems met and how they were fixed
- The first version of two of my tests was wrong (counted the sidecar document as an injector document; a destroy accepted inside a hook was never run). Fixed in the tests; the engine was not the problem.
- The text-file check failed on a byte order mark in the evidence file (written by PowerShell) and on stray characters in the runbook step written from PowerShell. Both were rewritten without them.
- A `QuotaPort` already existed with a different meaning of "global" (the per-user default). Kept as it was and added new names, so the kernel and its tests did not change.

- Review round: the reconciler could have swept the objects of a retry while the record was `failed` for a moment. Fixed with a record flag `retrying` (set before the `failed` report, cleared after the move to `provisioning` or on any exit) that the reconciler treats as busy; two tests added. The repeat lookup of a quota request now covers `stopping` and `failed` instances (two tests). `user_max` is the new name of the per-user default. The warm-pool trigger was reworded to what the JSON shows (`ready_after_s.p95` above 30 s, or `busy` above 0; new field `busy`), in ADR 0039, D-59 and runbook step 7. Quota versus retry (a failed instance frees its place although a retry may bring it back) is written in ADR 0039 and H-126; the missing FIFO order and the slot held by a retry are in `deferred-work.md`. Tests rerun for the touched files only: `test_engine_concurrency.py` and `test_reconcile.py` 75 passed; `test_measure.py` 10 passed; `test_ports_lab.py` and `test_ports_platform.py` 85 passed. The full suites were not rerun after this round.

## Security notes (vulnerable parts only)
Not a vulnerable part. The retry keeps secrets only in the worker's memory; nothing is logged (a test checks that no flag text reaches the output).

## Limitations and follow-ups
- Nothing is measured on vm-i and nothing with real images; ADR 0039 is Proposed until the developer confirms it after those numbers.
- The numbers 1, 5 and 20 are provisional (OI-21); the real `QuotaPort` and `InstancePort` are not written (H-79 stays open, H-126 for Akshay).
- The build slot counter is in memory: after an orchestrator restart waiting builds are not resumed (the reconciler handles the instances).
- The task L-16 in `docs/dev/dev1-tanmay.md` is not ticked and the Excel sheet is not changed; both wait for the developer's confirmation.
