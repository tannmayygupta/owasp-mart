# L-29: instances run in gVisor on vm-i, measured and proved live

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | l-29-gvisor-sandbox |
| Status | Done |
| Report tag | isolation, S-8, ADR 0056 |

## Requirements covered
L-29, NFR-ISO-05 to 07, spikes S-3, S-8, S-15 (S-15 is still the emulated result), ADR 0056.

## Summary
The live experiments that were skipped for the 19 October demo were run on vm-i with the developer's approval: gVisor (runsc) installed as an extra runtime, the whole lab run on it, user-namespace remapping tried on a throwaway second daemon. Every instance container of the live lab now runs under runsc and the deployed journey passes 34 of 34. Four defects showed up only in the live run and are fixed (name resolution, pids and memory room for the sandbox, a silent start failure, a unix socket shared between two sandboxes) plus one in the installer (an upgrade while instances run).

## Why
L-29's Done-when: the isolation tests pass on VM-I and the spike results record what worked and what did not. The note of 2026-10-18 was reasoning only.

## What was built
- Orchestrator: `--runtime` / `VM_ORCH_RUNTIME` (only runc or runsc, never from a template), the runtime on every container, fixed addresses and a hosts file for every instance network under runsc (`prepare_plan`, the edge container's reserved address), +96 pids and +64 MB of sandbox room, a sanitised log line for a refused start (`safe_detail`).
- `infra/hosts/vulnmart-install-gvisor.sh` (pinned, sha512 checked, atomic per file, `--host-uds=all`), `infra/hosts/gvisor.pin.json`.
- `scripts/live-deploy.mjs`: gVisor is the default for `lab`, a host without the runtime is refused, `--runtime runc` goes back.
- `scripts/sandbox-probe.mjs` (new: the container's view of the kernel and a shared-socket check), `scripts/isolation-probe.mjs` (`--runtime runsc` fixed: control by address, sandbox room), `scripts/vmi-audit.mjs` and `live-audit.mjs` (`--expect-runtime`, rule `instance-runtime`).
- Docs: `docs/research/s-8-instance-sandboxing.md` (measured), ADR 0056, `docs/runbooks/sandbox-gvisor.md`.

## How it works
Compose passes `VULNMART_ORCH_RUNTIME=runsc` to the orchestrator, which sets `Runtime` on each container it creates. A daemon without the runtime refuses the create, so an instance never starts on the host kernel by accident.

## Files changed
`apps/orchestrator/src/vulnmart_orchestrator/{backend,engine,service}.py`, `apps/orchestrator/tests/*`, `infra/compose/compose.yaml`, `infra/hosts/vulnmart-install-gvisor.sh`, `gvisor.pin.json`, `scripts/{live-deploy,live-audit,vmi-audit,isolation-probe,sandbox-probe}.mjs` and their tests, `scripts/check-lab-compose-rules.test.mjs`, docs and evidence.

## Decisions made
ADR 0056 (Accepted on the developer's instruction). Rejected after measurement: user-namespace remapping (breaks the uid-65532 tmpfs volumes). Rejected on reasoning: rootless Docker; not testable here: Kata/microVMs.

## Tests
- `apps/orchestrator` full suite: 473 passed.
- `node --test` of `sandbox-probe` 6, `isolation-probe` 24, `vmi-audit` + `live-audit` 30, `live-deploy` 6, `check-lab-compose-rules` 22: all passed.
- Live (records in `docs/assets/production-readiness/l29-*`): sandbox probe runc `shared host kernel` (kernel 7.0.0-1014-aws, 61 host modules visible) and runsc `user-space kernel` (4.19.0-gvisor, 0 modules), shared socket works in both; isolation probe 18 of 18 blocked in both; deployed journey 34 of 34 on runsc (ready 6.3 s versus 6.0 s on runc, first request 400 ms versus 375 ms); host audit rule `instance-runtime`: 12 instance containers, every one under runsc.

## Evidence
`docs/assets/production-readiness/l29-*` (probe reports, audit table, three journeys: attempt 1 and 2 are the failures that found the defects, `l29-e2e-runsc-final.json` is the pass).

## Problems met and how they were fixed
See the research note: DNS under gVisor, the sandbox's own pids and memory (found in the runsc debug log), the unix socket across two sandboxes (`--host-uds=all`), a start failure with no reason in the log, "Text file busy" on upgrade.

## Security notes
`unshare -U` is allowed inside gVisor (known item, no host right). `--host-uds=all` lets a sandbox create and connect unix sockets inside the paths it has mounted only. The second daemon of the userns test was removed and its user and data directory checked gone.

## Limitations and follow-ups
S-15 stays emulated. The shop has no client for the import socket yet, so C06 was not run through the shop end to end. No malicious player was run against the sandbox.