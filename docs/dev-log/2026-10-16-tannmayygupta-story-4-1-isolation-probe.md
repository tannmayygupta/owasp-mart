# Isolation probe from inside a real instance network, live checks and the VM-I runbook (story 4.1, spikes S-3 and S-15)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `1ee5c01` (commit of this story follows) |
| Status | Partly done: probe, live rules and runbook built and tested on Docker Desktop; the vm-i run (S-3, S-15) is the developer's and was not run |
| Report tag | isolation, NFR-ISO-01 to 04, spikes S-3 and S-15 |

## Requirements covered
NFR-ISO-01 to NFR-ISO-04, FR-INS-02, spikes S-3 and S-15, handoffs H-62 and H-71 (answer lines added), decision D-57 (Proposed), ADR 0037 (Proposed).

## Summary (plain language, 3-5 lines)
A new script builds a network and a locked-down container the way the orchestrator does, then tries to reach everything an instance must not reach (gateway, host, another instance, metadata, internet, LAN) and the one thing it may reach (its sidecar). It fails if anything forbidden connects or the sidecar does not answer. Two new live conformance rules check seccomp and the Docker socket. A runbook lists the exact steps for the developer on vm-i.

## Why
Nothing tested the isolation claim from inside an instance network. `verify-hosts.mjs` probes from a default bridge. S-3 (which host rule blocks the gateway) and S-15 (edge attach timing) were open.

## What was built
- `scripts/isolation-probe.mjs`: probe and report, injectable Docker runner, exit 0, 1 or 2.
- `scripts/check-instance-conformance.mjs`: rules `seccomp-not-unconfined` and `no-docker-socket` in `checkInspect`.
- `docs/runbooks/isolation-vm-i.md`: numbered developer steps with expected output and the evidence list.

## How it works
Two internal networks (A for the probe and a control with the alias `sidecar`, B for a peer) and three containers with user 65532, read-only root, cap_drop ALL, no-new-privileges, 64 MB, 0.5 CPU, 32 pids, a small tmpfs and no mounts. Listeners are checked on their own loopback first. One `docker exec` runs a small Node program in the probe container that connects to 16 forbidden targets plus the control (retrying up to 5 s) and prints a JSON list. The probe container is also checked with the existing `checkInspect` rules plus network, mount and limit checks. Leftovers (label `vm.kind=isolation-probe`) are removed first and always at the end.

## Files changed
- `scripts/isolation-probe.mjs`, `scripts/isolation-probe.test.mjs` (new)
- `scripts/check-instance-conformance.mjs`, `scripts/check-instance-conformance.test.mjs` (two rules and their drift cases)
- `docs/runbooks/isolation-vm-i.md`, `docs/adr/0037-isolation-probe-from-inside-an-instance-network.md` (new)
- `initial.md` (D-57), `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/HANDOFFS.md` (H-62 and H-71 answer text), `docs/bmad/initiative-lab/deferred-work.md`, the story plan file
- `docs/assets/story-4-1-isolation-probe/local-docker-desktop-report.json`

## Decisions made
ADR 0037 (Proposed): a standalone Node script on the Docker CLI instead of extending `verify-hosts.mjs` or using the orchestrator SDK. Open means a completed TCP connect only.

## Tests
- `node --test scripts/isolation-probe.test.mjs scripts/check-instance-conformance.test.mjs scripts/infra-isolation.test.mjs`: 86 tests, 86 passed, 0 failed (includes one real Docker run, about 15 s).
- `node scripts/isolation-probe.mjs --out docs/assets/story-4-1-isolation-probe/local-docker-desktop-report.json` on Docker Desktop (Docker 29.6.2): exit 0, `PASS (16 forbidden targets blocked, control reached)`; afterwards `docker ps -a` and `docker network ls` filtered by the label showed nothing.
- `node --test "scripts/*.test.mjs"`: 749 tests, 746 passed, 1 failed, 2 skipped. The failure is `generate-api-code.test.mjs` "a stale file is found by --check, written by the plain run, and CRLF alone is not stale" (line endings of the generated API file on this Windows checkout). It fails the same way with my changes stashed, so it is not caused by this story.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: both PASS.
- Rows updated in `docs/traceability.md`: NFR-ISO-01 to 04, S-3, S-15, D-57.

## Review round (2026-10-16)
Review round (2026-10-16): the verdict now fails on a target with no answer or an error state (only timeout, refused, unreachable and name-not-found count as blocked), on a non-zero exit code or an incomplete answer list from the in-container program (which now writes with a callback before exiting); SIGINT and SIGTERM run the labelled cleanup and exit 130; the report holds the probe and peer subnets, the peer must be on another network and subnet, and the probe container gets `--add-host host.docker.internal:host-gateway`; `--image` and `--timeout-ms` are validated (exit 2). Conformance: new rule `security-profiles-not-disabled` (apparmor, label, systempaths), the socket rule covers any `.sock`, named pipes and binds of parent directories. Runbook: one run at a time and manual cleanup, subnet check against `LABS_DOCKER_SUBNETS`, safety-net timer, empty-vm-i warning, evidence list. Deferred: UDP and IPv6 targets, exact tmpfs comparison with builder.py.
Tests after the round: `node --test scripts/isolation-probe.test.mjs scripts/check-instance-conformance.test.mjs` 79 tests, 79 passed (includes the real Docker run); a new local run of `node scripts/isolation-probe.mjs` gave exit 0, PASS, nothing left labelled.

## Evidence
`docs/assets/story-4-1-isolation-probe/local-docker-desktop-report.json`. On Docker Desktop the network gateway rows answer `refused` (the VM replies with a reset), `host.docker.internal` and the platform-like names `timeout`, everything else `unreachable`; none connected.

## Problems met and how they were fixed
- First idea for the report was to shorten the LAN target names; that made three rows identical, so the names stay as they are (they are not addresses of the machine).
- To check that the generate-api-code failure is old I stashed and restored the working tree once; another session's uncommitted work (story 3.7) was in the tree and came back unchanged.

## Security notes (vulnerable parts only)
Not a vulnerable part. The probe uses no privileged container, host network or Docker socket.

## Limitations and follow-ups
- Docker Desktop cannot show the host INPUT rule; S-3 and S-15 need the developer's run of `docs/runbooks/isolation-vm-i.md` on vm-i (not run here). The traceability rows say so.
- The edge container of S-15 is not built yet.
- A larger Docker address pool is a proposal in `deferred-work.md` (a change to `infra/hosts/`).
- The profile flags exist in the probe and in the orchestrator builder; a change of the builder must be mirrored by hand.
