# S-8 instance sandboxing: gVisor measured on vm-i, user namespaces and rootless Docker judged

Status: 2026-10-20, measured on the lab host (story L-29). Replaces the reasoning-only note of 2026-10-18. Decision: ADR 0056 (instances run in gVisor).

## Why it matters
An instance is a deliberately vulnerable shop that a stranger attacks. With runc the attacker's code runs as a process of the host kernel: the filters in front of it (dropped capabilities, seccomp, read-only root, no network) are what stands between an exploit and the host. gVisor (runsc) puts a second kernel, written in Go and running in user space, between the attacker and the host kernel: a kernel bug the player finds in the shop's environment is a bug of gVisor's kernel, not of the host's.

## What was measured (vm-i: Ubuntu, kernel 7.0.0-1014-aws, Docker 29, cgroup v2, x86_64; runsc release-20261012.0)

### The player's view of the kernel (`scripts/sandbox-probe.mjs`, the instance profile, no network)
| Question asked from inside the container | runc | runsc (gVisor) |
|---|---|---|
| kernel release | the host's: 7.0.0-1014-aws | 4.19.0-gvisor |
| `dmesg` first line | refused (not permitted) | "Starting gVisor..." |
| host kernel modules listed in /proc/modules | 61 | 0 |
| /proc/kcore readable | refused | refused |
| mount tmpfs | refused | refused |
| capabilities held | none | none |
| user namespace (`unshare -U`) | refused | **allowed** (see the finding below) |
| a unix socket shared through a volume between two containers (the import service and the shop) | works | works, **only with `--host-uds=all`** (see item 5) |
Verdict by the probe: runc `shared host kernel`, runsc `user-space kernel`. Records: `docs/assets/production-readiness/l29-sandbox-probe-runc.json`, `...-runsc.json`.

### Isolation (`scripts/isolation-probe.mjs`, the same 18 forbidden targets as S-3)
Both runtimes: 18 of 18 forbidden targets blocked (gateway, docker0, the other instance's network on 80 and 443, the platform event port, metadata, LAN, public addresses) and the control reached. Records: `l29-isolation-probe-runc.json`, `...-runsc.json`.

### The real lab on gVisor (`scripts/e2e-live.mjs`, the deployed journey)
34 of 34 checks pass with every instance container under runsc: sign-up, instance, ticket, gate, the shop and the sidecar, automatic capture of a flag read off the shop, hints, reset, submit, report, and the second-login rule. Time to ready 6.3 s (runc: 6.0 s); the first request through the gate 400 ms (runc: 375 ms): about +5 percent. Per instance, six containers, about 250 MB in use in total (shop 50 MB, sidecar 80 to 90 MB, the others 22 to 39 MB). `docker inspect` shows `Runtime: runsc` on every one; `scripts/vmi-audit.mjs --expect-runtime runsc` checks it (rule `instance-runtime`). Record: `l29-e2e-runsc-final.json`, `l29-vmi-audit-runsc.txt`.

## What did not work at first, and what fixed it (these are the useful results)
1. **Names did not resolve.** Docker's embedded name server lives in the network namespace that gVisor replaces: every alias lookup (`sidecar`, `shop`, `vulnmart-edge-gate`) failed with EAI_AGAIN, by address everything worked. The probe's control failed for this reason. Fix: with runsc the orchestrator gives each container of the instance a fixed address from .10 and a hosts file naming every alias, and reserves .2 for the edge container (the sidecar posts its events to it by name).
2. **The sandbox needs its own pids and memory.** gVisor's own processes and threads count against the container's limits. With the template's 32 pids the volume keeper died while starting in most tries ("failed to create new OS thread, errno=11"; found in the runsc debug log). Fix: the orchestrator adds 96 pids and 64 MB on top of the template for each sandboxed container (the workload keeps exactly the room the template gives it).
3. **The orchestrator said nothing about why a start failed.** It now logs the step the host refused, cut to one line with flag-shaped values and long hex or key-like runs removed.
4. **An upgrade of runsc failed with "Text file busy"** while instances ran: the install script now writes each file under a temporary name and renames it over the old one.
5. **A unix socket in a shared volume was invisible to the other sandbox.** The import service and the shop share `/run/import`. Two gVisor containers on one volume: the client got ENOENT; runc with runsc in either order: ECONNREFUSED or ENOENT; only runc with runc worked. With the runtime started with `--host-uds=all` every combination worked. The runtime is now installed with that argument. The cost is that a sandbox may create and connect unix sockets inside the paths it has mounted (an instance mounts its own volumes and never the Docker socket); `scripts/sandbox-probe.mjs` now checks the shared-socket case under both runtimes, so a regression shows up as a failed probe.

## Finding: user namespaces are allowed inside gVisor
`unshare -U` succeeds inside a gVisor container (refused under runc by the default seccomp profile). It is gVisor's own emulation: it does not give any right on the host, and the player's code still cannot mount or hold a capability (the probe checks both), but it widens what is reachable inside gVisor's kernel. Kept as a known item; not changed in this story.

## Options not taken
- **User-namespace remapping (userns-remap):** tried on a throwaway second daemon (`l29-userns-experiment.txt`). The instance volumes are tmpfs volumes owned by uid 65532; under remapping the container's 65532 is host uid 165532 and cannot write them ("Permission denied" where the live daemon writes fine). It also leaves the container on the host kernel (the 61 modules stay visible). Rejected.
- **Rootless Docker:** the bridge networks and the host firewall rules of the labs chain behave differently, which would invalidate the measured S-3 isolation result. Rejected, not tested.
- **Kata Containers / microVMs:** need hardware virtualisation, which the AWS instances used here do not expose. Not tested.
- **Address pool:** already one /16 with /24 networks (256 networks), inside the covered set; the audit passes (`daemon-pools`).

## Not covered
- gVisor does not make an exploit of gVisor itself impossible; it changes whose kernel the exploit has to beat.
- Nothing was run against a malicious player: the probes ask questions, they do not attack.
- The shop's code does not call the import service's socket anywhere yet (there is no client in `apps/shop/src`), so the C06 path through the shop was not exercised end to end; the mechanism it needs (a socket shared by two containers) is proved by the probe.
- The runc side of every number above is a measurement on the same host in the same hour, not a long-run benchmark.