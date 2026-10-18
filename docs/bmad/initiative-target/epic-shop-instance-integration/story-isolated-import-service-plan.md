---
title: 'Isolated import service'
type: 'feature'
ticket: '5'
created: '2026-10-12'
status: 'done'
baseline_revision: '1fe4dfd'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/instance/instance-contract.md'
  - '{project-root}/docs/research/RS-F-challenges-07-11.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-SHP-13 requires an import service that runs a fresh process per job with no network and no database access — the containment that makes C06 (prototype pollution in the product-import preview) safe to host (the pollution dies with the job). None exists (`services/import-service/` is a placeholder).

**Approach:** Build the service in `services/import-service/`: a unix-socket server (VM_IMPORT_SOCKET) that runs each preview job in a FRESH child process with a timeout, in a hardened container run with network_mode none and no /data mount. Correct flow only — the preview merge is SAFE (prototype-polluting keys dropped); the deliberate lodash-merge C06 is a later isolated path.

## Boundaries & Constraints

**Always:** A fresh child process per job, with a timeout; the service opens no network and no database; it writes only under /tmp and /run/import; Node built-ins only; hardened (non-root 65532, read-only root). Stay in `services/import-service/`.

**Never:** No shared state across jobs; no vulnerable merge (the correct merge drops `__proto__`/`constructor`/`prototype`); no db path/credentials; no outbound network; no deliberate weakness.

## I/O & Edge-Case Matrix

| Scenario | Expected |
|----------|----------|
| A job | runs in a fresh child process (new pid) and returns a preview |
| Two jobs | different worker pids (fresh process each) |
| `__proto__`/nested polluting payload | dropped; Object.prototype not polluted |
| A slow/hung job | killed by the timeout → `{ ok:false, error:'timeout' }` |
| Bad/oversized socket message | rejected; the server stays up |
| Network from inside | unreachable (network_mode none) |
| Database | no /data mount, no db env |

</frozen-after-approval>

## Code Map

- `services/import-service/src/server.mjs` -- new; `runJob` (fork per job + timeout), `createImportServer` (unix-socket, one job per connection).
- `services/import-service/src/worker.mjs` -- new; the per-job child: safe-merge preview, returns its pid, exits.
- `services/import-service/src/main.mjs` -- new; entrypoint on VM_IMPORT_SOCKET, process safety net.
- `services/import-service/Dockerfile` -- new; hardened distroless, no deps, socket-based healthcheck.
- `services/import-service/test/import-service.test.mjs` -- new; fork isolation, safe merge, timeout, socket round-trip.
- `services/import-service/instance-harness/import-isolation-check.mjs` -- new; the Docker isolation proof. `pnpm --filter @vulnmart/import-service run isolation:check`.

## Tasks & Acceptance

**Execution:**
- [x] `server.mjs`/`worker.mjs`/`main.mjs` -- fresh-process-per-job over a unix socket, safe preview, timeout.
- [x] Hardened Dockerfile (network-none-compatible, socket healthcheck).
- [x] Unit tests (fork isolation, safe merge, timeout, socket round-trip).
- [x] Docker isolation harness (fresh process, no network, no db).

**Acceptance Criteria:**
- A job runs in a fresh process (two jobs → different worker pids) and returns a correct preview; a slow job times out.
- The preview merge drops prototype-polluting keys and never pollutes Object.prototype.
- In the container (network_mode none, no /data mount): the network is unreachable from inside and there is no database env/mount.

## Implementation Notes

One job per connection keeps socket framing trivial (read to FIN, reply, close). Windows named pipes do not support that half-close, so the socket round-trip test is skipped on Windows (it runs on CI Linux and in the Docker harness). The live compose wiring (the shop talking to the service over the shared /run/import volume, and the /run/placement/import flag for C06) is L-13.

## Plan Change Log

## Review Triage Log

### 2026-10-12 — security/correctness review (Opus) + a functional bug found in testing

The review confirmed `safeMerge` is sound (no C06 weakness shipped: `__proto__`/`constructor`/`prototype` dropped at every level incl. the JSON.parse own-property case; arrays replace; no aliased mutation) and the isolation enforcement/harness are fail-closed. A functional bug and the review's real findings were fixed:

**Fixed:**
- **(functional, found in the Docker harness) The reply was never sent.** `net.createServer` defaults to `allowHalfOpen:false`, so when the client half-closed after sending the job, the server auto-ended its write side before the async worker finished — the response was lost (the harness and the Linux socket test both failed). Fixed with `allowHalfOpen:true`.
- **No worker concurrency cap (pid-exhaustion DoS)** — a burst of connections forked workers without limit (pids_limit 64). Added `MAX_INFLIGHT` (default 8); excess jobs are refused (`busy`), not queued.
- **No connection idle timeout (slowloris)** — a client that connects and never finishes held the fd forever. Added `conn.setTimeout` → destroy.
- **`__delay_ms` was attacker-reachable** — now honored only when `VM_IMPORT_TEST_HOOKS=1` (the test sets it; production ignores it).
- **Harness build path was cwd-relative** (broke under the package script) — resolved relative to the script with `fileURLToPath`.
- Nits: the health probe (empty input) no longer forks a worker (it answers directly); `uncaughtException` now logs and exits (the orchestrator restarts) rather than masking a bad state; the worker reports a `proto_check` so the test proves no in-worker pollution (not a vacuous parent-process check); the fresh-pid test overlaps two jobs so it cannot flake on pid reuse; added a `bad_json` socket test.

## Design Notes

`fork` (IPC) rather than `spawn`, so the worker returns its result as a structured message and its pid; the child is SIGKILLed on completion and on timeout, so no worker outlives its job. The safe merge is the correct counterpart to C06's vulnerable lodash merge.

## Verification

**Commands:**
- `node --test "services/import-service/test/**/*.test.mjs"` -- expected: pass (socket test skipped on Windows, runs on Linux).
- `pnpm --filter @vulnmart/import-service run isolation:check` (needs Docker) -- expected: `import-service: PASS`.
