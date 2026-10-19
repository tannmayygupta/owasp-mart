# Runbook: instances in gVisor

Story L-29, ADR 0056, research `docs/research/s-8-instance-sandboxing.md`. Files: `infra/hosts/vulnmart-install-gvisor.sh`, `infra/hosts/gvisor.pin.json`, `scripts/sandbox-probe.mjs`, `scripts/isolation-probe.mjs`, `scripts/vmi-audit.mjs`, `scripts/live-deploy.mjs`.

## Install on a lab host (once, and for an upgrade)
1. Read the pin: `infra/hosts/gvisor.pin.json` (release and sha512 of the tarball).
2. Copy and run as root on vm-i: `sudo sh vulnmart-install-gvisor.sh <release> <sha512>` (for example `20261012.0` and the hash of the pin). It downloads the tarball from Google's release bucket, checks the published hash and the pin, writes every file under a temporary name and renames it into /usr/local/bin (an upgrade works while instances run), merges `{"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}` into daemon.json and restarts Docker once. live-restore keeps the running containers. `latest` instead of a release prints the hash so a new pin can be made after the probes pass.
3. Check: `docker info --format '{{json .Runtimes}}'` lists `runsc`.

## Deploy the lab with it
`node scripts/live-deploy.mjs build`, `ship-i`, then `lab --secrets <folder> --zone <labs zone>`: gVisor is the default, and the deploy refuses to start when the host has no runsc. `--runtime runc` goes back (instances then share the host kernel).

## Prove it (read-only)
- `node scripts/sandbox-probe.mjs --runtime runsc` and `--runtime runc` on the host: the container's view of the kernel (expect `user-space kernel`, kernel 4.19.0-gvisor, no host modules, for runsc).
- `node scripts/isolation-probe.mjs --runtime runsc`: 18 of 18 forbidden targets blocked.
- `node scripts/live-audit.mjs --out <folder> --instances 7 --expect-runtime runsc`: rule `instance-runtime` fails when any instance container is not under runsc.
- The deployed journey: `node scripts/e2e-live.mjs ...` (34 checks).

## When something fails
- An instance fails in a few seconds: the orchestrator log now holds "start refused by the container host ..." with the step. A runsc sandbox that dies while starting ("StartRoot ... EOF") usually means too few pids or memory; the orchestrator adds the sandbox room (backend.py `SANDBOX_PIDS_OVERHEAD`, `SANDBOX_MEMORY_OVERHEAD_MB`).
- A name does not resolve inside an instance: expected under gVisor; the hosts file lists the aliases (backend.py `prepare_plan`). A new alias that an instance needs by name must be an alias of a component of the plan, or the edge container.
- runsc debug log, only for a test: add `"runtimeArgs": ["--debug-log=/var/log/runsc/", "--debug"]` to the runsc entry of daemon.json, restart Docker, read `/var/log/runsc/*boot*`; remove it afterwards (the install script resets daemon.json).