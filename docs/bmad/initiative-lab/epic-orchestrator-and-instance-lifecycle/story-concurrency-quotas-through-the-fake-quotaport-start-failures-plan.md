---
title: 'Concurrency, quotas through the fake QuotaPort, start failures, warm-pool decision'
type: 'feature'
ticket: '6'
created: '2026-10-16'
status: 'draft'
baseline_revision: ''
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Many instances cannot yet be started at once under control, nothing enforces per-user, per-company and global instance quotas (FR-INS-06, OI-21), a failed start is not retried (FR-INS-08, OI-24), and nobody has decided whether a warm pool is needed (FR-INS-09). Handoffs H-66, H-79, H-72.

**Approach:** (1) Orchestrator: a cap on parallel builds (a setting, default 4) so a burst does not overload Docker, and one retry of a failed start inside the build worker (the worker still holds the secrets; the retry sweeps first, reports `failed` then `provisioning` again) for the start and health failures only. (2) Quotas: a `QuotaPort` (Protocol plus an in-process fake with configured limits) used by the lab's `InstancePort` layer above `InstanceHost` (where it lives today: find it in `apps/api/src/vulnmart/ports/`); it refuses a request that would exceed the per-user, per-company or global limit with the existing IF-8 code `INST-QUOTA-REACHED` and counts only live instances. (3) A measurement of concurrent starts with the existing `measure.py` tool (a `--concurrent N` option), run locally for the tests and recorded as local only; the real numbers are the developer's run on vm-i (a runbook step). (4) The warm-pool decision is written as ADR 0039 (Proposed, for the developer to confirm): no warm pool for the first release; revisit when the vm-i cold start of the shop template is above 30 s at the 95th percentile or when more than 10 percent of starts wait for capacity. Decided on the developer's delegation, recorded as D-59.

## Boundaries & Constraints

**Always:** Retry only the codes `INST-START-FAILED` and `INST-HEALTH-TIMEOUT`, at most `start_retries` times (setting, default 1, 0 to 2); never retry `INST-INJECT-FAILED` (a bad document does not get better) and never after a destroy. The retry reuses the same plan and the same secrets in memory; nothing is logged or stored. A destroy during a retry cancels it. Concurrency cap: builds beyond the cap wait in the worker (state `requested` stays until a slot frees), never fail because of the cap. Quotas: defaults in the fake are per user 1, per company 5, global 20 (all settings of the fake, changeable by tests and later by the platform); counting excludes `destroyed` and `failed`; a repeat of an accepted request is never refused by quota. Capacity (memory) checks stay as they are. The fake `QuotaPort` and the settings are the only places with these numbers. The measurement run must not leave anything behind and prints no secret. ADR 0039 states what is measured locally and what is not measured yet.

**Never:** Changing IF-5 or any contract file (quotas live above `InstanceHost`; no new error code); touching Akshay's non-port code in `apps/api` (read it, write only ports and tests); running AWS or vm-i; `.github/workflows/**`; the Excel tracker; pushes and commits; deciding the warm pool as final (the developer confirms the ADR after the vm-i numbers).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Burst | 20 creates at once on the fake backend, cap 4 | at most 4 builds run at the same time; all 20 end `ready` | none |
| Start fails once | first attempt exits `START_FAILED`, second works | reports: failed, provisioning, ... ready; old objects removed between | none |
| Start fails every time | retries used up | ends `failed` with the code, nothing left | as create failure |
| Inject failure | injector exits 1 | no retry, `failed` | as create failure |
| Destroy during retry | destroy accepted while the retry runs | cancelled, destroyed | none |
| User quota | second live instance of the same owner | refused with INST-QUOTA-REACHED, nothing created | IF-8 body |
| Company quota | 6th instance of a company of 5 | refused | IF-8 body |
| Global quota | 21st instance | refused | IF-8 body |
| Freed slot | one instance destroyed | the next request is accepted | none |
| Repeat | same request again over quota | 200 repeat, not refused | none |
| Concurrency measure | `measure.py --concurrent 3` locally | prints start times and memory, removes everything | exit non-zero on a failed start |

</frozen-after-approval>

## Code Map

- `apps/orchestrator/src/vulnmart_orchestrator/engine.py` -- `_run_create` (:244) and `_run` (:259), `_fail`; add the retry loop and a `threading.BoundedSemaphore` for builds; `lifecycle.py` `Settings`: `max_parallel_builds`, `start_retries` (validated).
- `apps/orchestrator/src/vulnmart_orchestrator/measure.py` -- the S-4 tool (`owner_hash` helper at :47): add `--concurrent N`.
- `apps/api/src/vulnmart/ports/instance_port.py` (find the file; Akshay's provisional `InstancePort`, `AttemptPort`, `ReportPort`, fakes, `lab_fakes.py`) -- add `QuotaPort`, `FakeQuotaPort`, the enforcement in the port layer, `INST-QUOTA-REACHED` from the IF-8 registry (`contracts/errors/`).
- Tests: `apps/orchestrator/tests/test_engine_lifecycle.py` or a new `test_engine_concurrency.py`, `apps/api/tests/` (port tests), `test_measure.py`.
- Docs: ADR 0039 (warm pool, Proposed), `initial.md` D-59, `docs/runbooks/measure-instances.md` (a numbered `--concurrent` step for vm-i with the evidence to save), `docs/dev/HANDOFFS.md` (H-66, H-72, H-79 answers; a row for Akshay about the quota numbers and the port), CHANGELOG, traceability (FR-INS-06, 08, 09), dev-log, evidence `docs/assets/story-3-6-concurrency-quotas/` (a real local run, labelled local), story `built`.

## Tasks & Acceptance

**Execution:**
- [ ] `engine.py`, `lifecycle.py` -- parallel-build cap and the start retry with settings
- [ ] `ports` (apps/api) -- `QuotaPort`, fake, enforcement above `InstanceHost`
- [ ] `measure.py` -- `--concurrent N`
- [ ] tests -- every matrix row
- [ ] runbook and docs as in the Code Map

**Acceptance Criteria:**
- Given 20 simultaneous creates on the fake backend with cap 4, then the highest number of builds running together is at most 4 and all 20 become ready.
- Given a start that fails once, then the instance becomes ready on the retry and the platform sees `failed` then `provisioning` reports.
- Given quotas 1, 5 and 20, then the refusals are INST-QUOTA-REACHED and nothing is created.
- Given a local `measure.py --concurrent 3` run, then evidence with start times is saved, labelled as local Docker Desktop only.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` and the `VM_ORCH_SERVICE=python` suites -- expected: pass
- `node scripts/check-contract-rules.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
