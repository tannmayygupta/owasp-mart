# 0037. Isolation probe from inside an instance network

- **Status:** Proposed (D-57, decided on the developer's delegation; to be confirmed)
- **Date:** 2026-10-16
- **Deciders:** Tanmay (by delegation to Claude Code, story 4.1 "Isolation probe from inside a real instance network, live checks and the VM-I runbook")
- **Requirements:** NFR-ISO-01 to NFR-ISO-04, FR-INS-02; decisions D-43, D-52; spikes S-3, S-15; handoff H-62

## Context
The claim "an instance reaches nothing but its own sidecar" had no test from inside a network built the way the orchestrator builds it. `scripts/verify-hosts.mjs` runs its probe on a default bridge, which proves nothing about an internal instance network. Whether the host INPUT rule or the DOCKER-USER chain blocks the gateway address (S-3), and how the labs edge behaves with many attached networks (S-15), were not measured. Claude must not run anything on AWS or vm-i.

## Options considered
1. **Extend `verify-hosts.mjs`.** It is an SSH-driven host check and its probes run on a default bridge. Mixing a local, Docker-only probe into it hides what is tested. Rejected.
2. **A probe built on the Python SDK of the orchestrator.** Reuses the builder but needs `uv` and the package on vm-i, and a bug in the builder would also bend the probe. Rejected.
3. **A standalone Node script using only the Docker CLI (chosen).** It mirrors the profile with explicit flags (so it is an independent statement of the profile), runs anywhere Docker and Node run (Docker Desktop and vm-i), and has an injectable Docker runner so every outcome is unit tested without a daemon.
4. **Where the probe runs.** A throwaway container started detached with a sleep, then `docker exec` of one small Node program that tries every target in parallel with a 3 second limit. Chosen over a one-shot container so the container can be inspected while it exists.

## Decision
- The probe creates two internal networks and three hardened containers (probe, a control with the alias `sidecar`, a peer on the other network), all labelled `vm.kind=isolation-probe`, removes leftovers of an earlier run first and removes its own objects in every case.
- Open means a completed TCP connect. Timeout, refusal, unreachable and name-not-found are blocked (a refusal from the gateway is a reply from the host, noted in the runbook, but the rule of the plan counts only a connect as open).
- A run fails (exit 1) when a target is open, when the control is not reached (the probe would prove nothing), when a listener did not start, or when `docker inspect` of the probe differs from the profile (it reuses `checkInspect` of the conformance script). Docker missing is exit 2.
- The conformance live checks get two rules: `seccomp-not-unconfined` and `no-docker-socket` (bind, named pipe, or an engine socket path).
- Local Docker Desktop runs show the internal network only (its host is a VM). The host rule is shown by the runbook `docs/runbooks/isolation-vm-i.md`, which the developer runs (rule on and off, after a Docker restart, after a reboot, a port scan note, S-15 timing).

## Consequences
Easier: one command shows that an internal network blocks every forbidden target, and the same command is the check on vm-i. Harder: the profile exists twice (builder and probe flags); drift is caught because the probe also checks the container with the conformance rules, but a change of the builder profile must be mirrored by hand. The probe uses a public address (1.1.1.1) as a target, so a run needs no internet, only that it never connects. The S-3 and S-15 answers are not known until the developer runs the runbook.

## Evidence
Docker documents that `--internal` networks have no external connectivity (https://docs.docker.com/engine/network/drivers/bridge/). The local run on Docker Desktop is in `docs/assets/story-4-1-isolation-probe/`. Not verified on vm-i.
