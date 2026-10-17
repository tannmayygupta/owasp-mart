# Isolated import service (T-12)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, isolated import service (FR-SHP-13) |

## Requirements covered
FR-SHP-13 (an import service that runs a fresh process per job with no network and no database access). BMAD story 2.5 of `epic-shop-instance-integration`.

## Summary (plain language, 3-5 lines)
Built the isolated import service: a unix-socket server that runs each product-import preview job in a fresh child process with a timeout, in a hardened container run with network_mode none and no /data mount. Correct flow only — the preview merge is safe (prototype-polluting keys are dropped); the deliberate lodash-merge C06 is a later isolated path. Proven with unit tests (fork isolation, safe merge, timeout, socket round-trip) and a Docker harness showing a job runs in a fresh process and the service cannot reach the network or a database.

## Why
C06 (prototype pollution in the product-import preview) is only safe to host because the pollution dies with the job: a fresh process per job, no network, no database. This containment is the import service; the vulnerable merge is added later in an isolated path.

## What was built
- `services/import-service/src/server.mjs` — `runJob` (fork per job + timeout, concurrency cap) and `createImportServer` (unix socket, one job per connection, idle timeout).
- `services/import-service/src/worker.mjs` — the per-job child: safe-merge preview, a prototype self-check, returns its pid, exits.
- `services/import-service/src/main.mjs` — entrypoint on `VM_IMPORT_SOCKET`, process safety net.
- `services/import-service/Dockerfile` — hardened distroless, no deps, socket-based healthcheck.
- `services/import-service/test/import-service.test.mjs` — fork isolation, safe merge, timeout, socket round-trip + bad JSON.
- `services/import-service/instance-harness/import-isolation-check.mjs` — the Docker isolation proof.

## How it works
The shop connects to `VM_IMPORT_SOCKET`, sends one job and half-closes; the server reads it, forks a fresh worker (capped at `MAX_INFLIGHT`), waits up to the timeout, writes the result and closes. The worker computes the preview with a safe merge (dropping `__proto__`/`constructor`/`prototype` at every level) and reports a `proto_check`; it is SIGKILLed on completion or timeout, so no worker outlives its job. The container runs network_mode none with no /data mount, so the service has no network and no database.

## Files changed
- `services/import-service/{src/*, Dockerfile, package.json, test/*, instance-harness/*}` — new.

## Decisions made
`fork` (IPC) so the worker returns a structured result + its pid; the child is killed on completion and timeout. One job per connection keeps socket framing trivial (read to FIN, reply, close) — which required `allowHalfOpen` (below). Node built-ins only. The deliberate C06 lodash merge is a later isolated path. The live compose wiring (the shop over the shared /run/import volume, and the /run/placement/import C06 flag) is L-13.

## Tests
Real commands and results:
- `node --test "services/import-service/test/**/*.test.mjs"` → **5 passed, 1 skipped** (the socket round-trip + bad-json test is skipped on Windows — named-pipe half-close — and runs on CI Linux): a job returns a fresh-process preview; two overlapping jobs run in different worker processes; a `__proto__`/nested payload is dropped and the worker's prototype stays clean; a slow job times out; non-object input yields the safe default.
- `pnpm --filter @vulnmart/import-service run isolation:check` (Docker 28.5.1) → **`import-service: PASS (7 checks)`**: the service answers on its socket, two jobs run in different worker processes, the preview is correct, the network is unreachable from inside, the network mode is none, there is no /data mount, and there is no database env.
- Traceability row FR-SHP-13 (import service) added in `docs/traceability.md`.

## Evidence
Test + harness output above; the harness runs the real image with network_mode none and no /data mount, and drives the service over its unix socket.

## Problems met and how they were fixed
The Docker harness caught a functional bug the unit tests missed (the socket round-trip is skipped on Windows): `net.createServer` defaults to `allowHalfOpen:false`, so when the client half-closed after sending the job the server auto-ended its write side before the async worker finished — the reply was never sent. Fixed with `allowHalfOpen:true`. The security review then added: a worker concurrency cap (pid-exhaustion DoS), a connection idle timeout (slowloris), gating the `__delay_ms` test hook behind `VM_IMPORT_TEST_HOOKS` (it was attacker-reachable), fixing the harness build path (was cwd-relative, broke under the package script), not forking on empty health probes, exiting on `uncaughtException`, a worker-reported `proto_check` (the parent-process pollution check was vacuous), and an overlap-based fresh-pid test (no pid-reuse flake).

## Security notes (vulnerable parts only)
No deliberate weakness — this is the containment. The merge is safe (no prototype pollution). Each job is a fresh, time-bounded child killed when done; concurrency is capped so a burst cannot exhaust the pid budget; the connection has an idle timeout; the `__delay_ms` hook is test-only. The container has no network and no database.

## Limitations and follow-ups
- The deliberate C06 vulnerable merge (lodash) and the C06 flag from `/run/placement/import` are the challenge epic's isolated path.
- The live docker-compose wiring of the import service into a full instance (the shop talking to it over the shared /run/import volume) is L-13; T-12 proves the container's isolation via its own harness.
