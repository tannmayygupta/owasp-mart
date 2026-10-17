---
title: 'Local end-to-end loop on Docker Desktop: orchestrator, edge, gate, sidecar, ingest, score, and a small load check'
type: 'feature'
ticket: '3'
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
context: ['{project-root}/docs/runbooks/local-demo.md', '{project-root}/docs/runbooks/measure-instances.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** Pieces are proven separately on Docker Desktop: the orchestrator creating stub and shop instances (`node scripts/dev.mjs demo`), the edge, gate and Caddy fronting stub instances with a fake ingest (`scripts/e2e/edge.e2e.test.mjs`), the sidecar. Nobody has run one candidate through all of them into the real ingest handler and the score. The demo on 19 Oct needs that, and LX-2 needs one load number.

**Approach:** `scripts/e2e/loop.e2e.test.mjs`, built from what the two existing files already do (copy the few helpers you need into `scripts/e2e/loop-support.mjs`; do not refactor `demo.mjs` or `edge.e2e.test.mjs`; import the exported pure helpers `buildManifest`, `reduceTemplate`, `relaxSchema`, `redact` from `scripts/demo.mjs` and `signTicket`, `signCookie`, `newJti` from `apps/edge/src/tickets.mjs`). Steps, each its own `test()` so a failure names the step:
1. preflight: Docker running, `uv`, `openssl`, ports free (skip the whole file with a message otherwise); everything is labelled `vm.kind=loop-test` and `vm.run=<id>`.
2. start the lab runtime: `uv run --locked --package vulnmart-api uvicorn vulnmart.kernel.entrypoints.ingest:app --port <free>` with `VULNMART_LAB_RUNTIME=1`, `VULNMART_LAB_DEMO=1`, a random `VULNMART_LAB_DEMO_TOKEN`, `VULNMART_ORCH_URL` and the orchestrator signing key file (story 1).
3. start the real orchestrator as `demo.mjs` does (Docker backend, temporary signing key, reduced template, stub image `vulnmart-stub-instance:local`).
4. start Caddy and the edge gate with the run flags read from `infra/compose/compose.yaml`, the relay upstream set to the lab runtime's `POST /internal/v1/events`.
5. `POST /attempts` through the demo route: the orchestrator creates the instance; wait for state `running`.
6. mint a gate ticket in Node, open the instance host name through Caddy (self-signed certificate), reach the stub shop.
7. trigger the stub's exploit path for one challenge; the sidecar sends a signed event over the edge relay; poll the demo score route until the milestone is credited (bounded wait, 30 s).
8. read the flag for that instance from the container's own environment file the injector wrote (the test reads it, the report does not print it), submit it through `POST .../flags`, check M3 and the score against the hand number of story 2.
9. `POST /advance` to the deadline, `POST /tick`: attempt `submitted`, access `frozen` (the gate answers its frozen page), advance 15 minutes, tick: instance destroyed (the orchestrator lists none).
10. cleanup in `after()`: everything labelled with the run id is removed and a check proves none is left.

`scripts/load-check.mjs` starts N stub instances at once through the real orchestrator (default N = 6, `--n` to change), records the time to `ready` for each (p50, max), container memory (`docker stats --no-stream`), and destroys them; prints PASS when every instance is ready within a stated target (placeholder 60 s, OI-25 style) and writes the numbers to `docs/assets/story-8-3-loop-and-load/load-check.txt` with the machine's CPU and RAM stated. The NFR-PRF concurrency target on the deployed VM-I is NOT proven by this: it is a runbook step (story 6, `measure-instances.md` method).

**Proposed (decided on the developer's delegation):**
- **D-97 (part):** the Docker layer reuses the existing harnesses and the real orchestrator, runs only on Docker Desktop, skips cleanly without it, and is never a CI gate (CI Linux has its own `ci:linux`); it is the demo's "real containers" proof and the developer runs it before the demo. If the whole loop is not green by the evening of 18 Oct, the demo falls back to the in-process loop (story 2) plus the two existing separate proofs (`dev.mjs demo`, `edge.e2e.test.mjs`), and the dev-log says so.

## Boundaries & Constraints

**Always:** random temporary keys and a temporary folder; the self-signed certificate made in the run; loopback only (`127.0.0.1`), no published port on `0.0.0.0`; every container and network labelled and removed even when a step fails; the report and the evidence file are redacted by `redact` and hold ids, states, numbers and result words only; the flag value is read and used inside the test and never printed or written; one run at a time (`--test-concurrency=1`, as `test:e2e` already sets).

**Never:** AWS, VM-I, ssh or any outside network call; changing `demo.mjs`, `edge.e2e.test.mjs`, compose files, the orchestrator, the edge, the sidecar or the contracts to make the loop pass (a failing seam is reported to its owning story); touching containers or volumes that are not labelled with this run's id (for example `n8n_data`); the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No Docker | daemon off | file skipped with a message | none |
| Port busy | a needed port in use | stops before starting anything, names the port | none |
| Happy loop | all steps | 10 steps PASS, nothing left | none |
| Event never arrives | relay or sidecar broken | step 7 fails after 30 s naming the hop (sidecar logs tail, redacted) | cleanup still runs |
| Frozen gate | after expiry tick | gate answers its frozen response, not the shop | none |
| Interrupted run | Ctrl+C | next run's preflight lists leftovers by label and refuses to start until `--clean` removes only labelled ones | none |
| Load check | N = 6 | table of ready times, memory, PASS or FAIL against target | exit 1 on FAIL |

</frozen-after-approval>

## Code Map

- `scripts/demo.mjs` (exports above, `startOrchestrator` logic inside `demo`), `scripts/dev.mjs` (`COMPOSE_FILE`, `run`, `dockerRunning`, `portFree`), `scripts/e2e/edge.e2e.test.mjs` (Caddy, edge, networks, self-signed certificate, labels), `scripts/e2e/orchestrator.e2e.test.mjs` (orchestrator start pattern).
- `apps/edge/src/tickets.mjs` (`signTicket`, `signCookie`, `newJti`), `contracts/edge/gate-ticket.md`.
- `contracts/mocks/stub-instance/*` (stub shop, sidecar, injector, `inject.mjs`), `infra/compose/compose.yaml` (`edge-gate`, `edge-caddy` run flags).
- `docs/runbooks/measure-instances.md` -- the measurement method for the load check.
- New: `scripts/e2e/loop.e2e.test.mjs`, `scripts/e2e/loop-support.mjs`, `scripts/e2e/loop-support.test.mjs` (pure helpers only), `scripts/load-check.mjs`, `scripts/load-check.test.mjs` (stats and formatting, no Docker). Add `loop-support.test.mjs` and `load-check.test.mjs` to the `test` script pattern only if they sit under `scripts/` (they do not need a change; `scripts/e2e/*.test.mjs` runs under `test:e2e`).
- docs: dev-log, CHANGELOG, traceability LX-1, LX-2 (local), `docs/runbooks/local-demo.md` (a section "Full loop"), evidence `docs/assets/story-8-3-loop-and-load/`.

## Tasks & Acceptance

**Execution:**
- [ ] `loop-support.mjs` and its pure tests (label filter, leftover finder, bounded poll, redaction)
- [ ] steps 1 to 10 in `loop.e2e.test.mjs`, one at a time, run after each addition
- [ ] `load-check.mjs` + tests of the statistics
- [ ] run on Docker Desktop and record the real output and the real numbers (machine specs stated)
- [ ] docs -- dev-log (including dead ends), CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given Docker Desktop, then the loop file passes end to end and `docker ps -a --filter label=vm.kind=loop-test` is empty afterwards.
- Given the frozen state, then the gate does not reach the shop and after the destroy tick the orchestrator lists no instance.
- Given the load check, then real ready times and memory are printed and saved, labelled as laptop numbers.
- Given no Docker, then the file skips with a message and the pure tests pass.

## Verification

**Commands:**
- `node --test scripts/e2e/loop-support.test.mjs scripts/load-check.test.mjs` (pure tests, no Docker)
- `node --test --test-concurrency=1 scripts/e2e/loop.e2e.test.mjs` (Docker Desktop; expected: pass)
- `node scripts/load-check.mjs --n 6` (Docker Desktop; expected: numbers and PASS or a stated FAIL)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/scan-flags.mjs`
