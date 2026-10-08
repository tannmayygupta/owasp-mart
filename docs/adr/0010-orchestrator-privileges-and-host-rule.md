# 0010. Orchestrator privileges and the host-side drop rule

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** D-23, NFR-SEC-02, NFR-SEC-04, NFR-ISO-02, NFR-ISO-05

## Context
Docker socket access is root on the host. Docker says an internal network still allows the gateway IP and host services. The PRD names DOCKER-USER for the drop rule.

## Options considered
1. Separate orchestrator on the instance host behind a socket proxy, building containers from templates only.
2. Rootless Docker: lowers daemon-escape damage, changes networking and the rule.
3. Remote daemon over SSH: more moving parts.
Rule placement: (a) DOCKER-USER; (b) INPUT chain.

## Decision (proposed)
Option 1; rootless as optional hardening after spike S-8. Rule in the INPUT chain (container-to-host traffic is local delivery), DOCKER-USER kept for defence in depth. The orchestrator accepts instance ids and allowlisted template names only, listens on a private address with mTLS and signed requests, holds no master keys and audits every action. ASVS level 3.

## Consequences
The INPUT claim is an inference and must be proved in S-3. Docker Desktop cannot take the rule, so the laptop is lower assurance. A socket proxy filters by API section, not request body, so orchestrator code is the control.

## Evidence
https://docs.docker.com/reference/cli/docker/network/create/ (VERIFIED); https://docs.docker.com/engine/network/firewall-iptables/ (VERIFIED: FORWARD and DOCKER-USER; INPUT UNVERIFIED); socket proxy behaviour UNVERIFIED. See docs/architecture/06-security.md section 4.
