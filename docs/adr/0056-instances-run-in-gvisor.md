# 0056. Instance containers run in gVisor (runsc)

- **Status:** Accepted (the developer's instruction in chat, 2026-10-20: implement the sandbox experiments and adopt what passes)
- **Date:** 2026-10-20
- **Deciders:** Tanmay (developer), stream L
- **Requirements:** NFR-ISO-05 to 07, spike S-8, story L-29, D-72 (a stranger attacks the shop)

## Context
The lab runs a deliberately vulnerable shop for strangers to attack. With runc the attacker's code is a process of the host kernel. The earlier note of 2026-10-18 was reasoning only, because the live experiments were skipped for the demo.

## Decision
- Every instance container (shop, injector, sidecar, import service, mock services, bot controller, volume keeper) asks the daemon for the `runsc` runtime. The orchestrator takes it from `--runtime` or `VM_ORCH_RUNTIME` (compose: `VULNMART_ORCH_RUNTIME`), only `runc` or `runsc` are accepted, it is never read from a template or a request, and a daemon that lacks the runtime refuses the create: an instance never starts on the host kernel by accident.
- gVisor is an extra runtime. The daemon's default stays runc, so nothing else on the host changes. `infra/hosts/vulnmart-install-gvisor.sh` installs a pinned release (`infra/hosts/gvisor.pin.json`, sha512 checked) and merges the runtime into daemon.json with the argument `--host-uds=all` (two sandboxes sharing a volume, the import service and the shop, cannot otherwise connect through a unix socket in it; the trade is that a sandbox may create and connect unix sockets inside the paths it has mounted, never the Docker socket); Docker restarts once and live-restore keeps running containers.
- `scripts/live-deploy.mjs lab` runs instances in gVisor by default, refuses to start on a host without the runtime, and takes `--runtime runc` as the explicit way back.
- Because gVisor cannot use Docker's name server, each sandboxed container gets a fixed address and a hosts file; and because the sandbox's own threads and memory count, each gets +96 pids and +64 MB on top of the template (see `docs/research/s-8-instance-sandboxing.md`).

## Alternatives considered
User-namespace remapping (measured: breaks the uid-65532 tmpfs volumes, leaves the host kernel shared), rootless Docker (invalidates the measured S-3 result), Kata or microVMs (needs hardware virtualisation the hosts do not have). Details and numbers in the research note.

## Consequences
Better: a kernel bug in the player's environment is a bug of gVisor's kernel; the container sees no host kernel version or modules; the audit checks it (`vmi-audit --expect-runtime runsc`, rule `instance-runtime`). Cost: about +5 percent time to ready, about 20 MB per container; `unshare -U` works inside gVisor (known item); an upgrade of runsc needs a pin change and a re-run of the probes.

## Sources
gVisor installation guide (the tarball layout and the Docker setup); the measurements of 2026-10-20 in `docs/assets/production-readiness/l29-*`.