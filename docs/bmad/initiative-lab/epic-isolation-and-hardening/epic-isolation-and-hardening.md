---
type: epic
title: "Instances are isolated and the host is protected"
parent: initiative-lab
covers: []
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Instances are isolated and the host is protected

## Description

Each instance runs on internal networks with no route out, containers are hardened, the host drops traffic from instance networks, the orchestrator is reachable only through a socket proxy and accepts template IDs only, and extra hardening is added only where tests pass.

## Outcome

A hostile instance cannot reach the internet, other instances, the platform or the host; the signal is NFR-ISO-01 to 07 and NFR-SEC-02 and 04 passing with real tests on VM-I.

## Requirements

- LI-1: Per-instance internal networks with no route out (NFR-ISO-01, NFR-ISO-07; D-23).
- LI-2: A host-side rule drops instance-to-host traffic and host services listen on loopback or the private link only (NFR-ISO-02; ADR 0010; spike S-3).
- LI-3: Hardened containers: no capabilities, non-root, read-only filesystem, no-new-privileges, default seccomp, limits (NFR-ISO-03).
- LI-4: Platform networks are separate and the Docker socket is behind a socket proxy; the orchestrator accepts template IDs only (NFR-ISO-04, NFR-SEC-04).
- LI-5: User namespaces, rootless Docker and gVisor are added only where tests pass (NFR-ISO-05; spike S-8).
- LI-6: Docker's address pools are raised for two networks per instance (D-28; spike S-15).

## Done when

1. From inside an instance, `169.254.169.254`, the LAN, the internet, other instances, the platform, the gateway IP, host services and `host.docker.internal` are all unreachable, tested on VM-I.
2. No container is privileged, mounts the socket or host paths, or uses host networking.
3. The orchestrator rejects any request naming an image, volume, command, port or network.
4. Spike results S-3, S-8 and S-15 are recorded with what worked and what did not.
5. Deployed and verified on the VMs on VM-I.

## Boundaries

Isolation, hardening and the orchestrator's privileges. Not instance lifecycle logic (epic-orchestrator-and-instance-lifecycle) or the edge (epic-edge-gate-and-event-path).

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- prd, docs/prd/PRD.md, section 6.2
- decision, initial.md D-23, D-28
- architecture, docs/adr/0010-orchestrator-privileges-and-host-rule.md; docs/architecture/06-security.md

## Notes

- Unknown: whether the host drop rule can be installed and tested on Docker Desktop and on the Oracle VM; Docker documents `DOCKER-USER` in the forwarding path, container-to-host traffic is the INPUT chain (unverified, spike S-3).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
