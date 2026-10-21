# 0073. Durable gate and sidecar state, and the platform's list of wanted instances

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** the leader (instruction of 2026-10-21, work package C), Claude
- **Requirements:** wiring audit 2026-10-21 section 3 (edge gate map in memory, sidecar outbox evicts flag events, orchestrator without desired state); handoffs H-111, H-123, H-125; IF-5 1.2.0

## Context
1. After an edge restart every live lab answered "ended" until the orchestrator re-synced, and the used-ticket set was forgotten (a one-time ticket could be replayed inside its lifetime).
2. The sidecar kept 1000 events in memory and, when full, dropped the oldest even if it was a flag event.
3. The orchestrator's reconciler (story 3.5) had a port for "the instances the platform wants" but the service wired `AllWantedDesiredState`, so nothing was ever destroyed for being unwanted (H-123).
4. A first boot of a host that was cut off never retried the package step (H-111).

## Options considered
- **Gate state.** (a) Valkey: another dependency on vm-i for a single small map. (b) A signed file on a named volume of the edge only (chosen): `apps/edge/src/persist.mjs`, written atomically (temp file and rename, mode 0600), debounced, HMAC-signed with the current gate key (a previous key still verifies, so a rotation does not lose the state), all-or-nothing on load, and ignored when older than `EDGE_STATE_MAX_AGE_S` (600 s) because the orchestrator may have closed instances in the meantime: the gate then starts closed, as before. Failing writes are counted and shown in the admin status, never thrown into a request. The gate also counts and logs exceptions in `decide` (class name only) instead of hiding them as ordinary refusals.
- **Sidecar outbox.** A journal file (`--outbox`, one JSON line per event, appended before the shop gets its 202, torn last line ignored, compacted when most of it is struck off) replayed in order with the same seq and bytes after a restart, and tiered eviction: summaries first, then normal events, a flag or milestone only when nothing else is left, each counted apart. 409, 413 and 422 are dropped at once (they never succeed), 401 is retried with backoff, 5xx and silence are never dropped. The journal lives in the instance's `/tmp` tmpfs: it survives a restart of the process, not of the container (containers are not restarted by the orchestrator).
- **Wanted instances.** (a) The platform pushes the list: needs a new endpoint on the orchestrator and a trigger on every change. (b) The orchestrator reads it (chosen): `GET /internal/v1/orch/desired` on the platform, signed with the orchestrator's report key like the state report (one key, one nonce memory, the private listener of Caddy now allows this one GET). The platform lists the instance of every ready or running attempt and every start under way. Anything but a good 200 means "cannot tell" and puts the orchestrator in safe mode (nothing destroyed for being unwanted, creates refused), never an empty list by accident; an empty list is a real answer. An unlisted instance is destroyed only after it was unlisted in two passes in a row, which covers the milliseconds between the orchestrator accepting a create and the platform noting its id. Contract: IF-5 1.2.0, additive, section 8a.
- **First boot.** The baseline runs as a systemd oneshot unit (`Restart=on-failure`, `RestartSec=30`, `ConditionPathExists=!/var/lib/vulnmart/baseline-ok`) that installs the packages in `ExecStartPre` itself (idempotent), so any cut-off boot is repaired by the next start. The package list moved from cloud-init `packages:` into the unit to stay under the 16384-byte user-data limit (the rendered size is 16358 gzipped, as tight as before).

## Decision
As marked "chosen" above.

## Consequences
- A restarted edge keeps answering for live labs; a ticket used before the restart stays used.
- State reports are on in every deployed lab (`live-deploy.mjs` always stages `lab.reports.yaml`); the plain compose keeps them off because they need a secret file.
- The orchestrator's `FakeSettingsPort` default (admin idle and maximum settings) is NOT solved here: the settings still come from built-in defaults (logged at start). Open: a second signed read, like the desired state.
- `scripts/check-docker-proxy.mjs` is the repeatable conformance check of the Docker socket proxy (H-125); the live run on vm-i is the leader's.

## Evidence
- Atomic replace and `fsync` before rename: POSIX `rename(2)` semantics; HMAC with a constant-time compare as in `apps/edge/src/tickets.mjs`.
- systemd `Restart=` for `Type=oneshot` (supported since systemd 244; Ubuntu 24.04 ships 255): systemd.service(5).
- Local proof: gate restart test (`apps/edge/test/persist.test.mjs`, 16 tests), sidecar outbox (`services/sidecar/test/outbox.test.mjs`, 12 tests), reconciler (`apps/orchestrator/tests/test_desired_state.py`) and the platform route (`apps/api/tests/test_lab_desired_state.py`); the proxy script against the real HAProxy container of the lab profile: 36 of 36 rows.
