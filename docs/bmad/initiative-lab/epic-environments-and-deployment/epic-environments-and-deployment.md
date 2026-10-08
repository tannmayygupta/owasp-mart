---
type: epic
title: "Two Oracle VMs, certificates and deployment pipelines"
parent: initiative-lab
covers: []
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Two Oracle VMs, certificates and deployment pipelines

## Description

The two Oracle Arm VMs (platform and instances) exist with a private link and firewall, DuckDNS names and certificates work, the Vercel project is wired, images build for arm64 on the VM, encrypted backups run, and the laptop fallback starts the same stack. Every other epic delivers to production through this one.

## Outcome

Anything the three streams build can be deployed and demonstrated online and on the laptop; the signal is the platform and a stub instance reachable over HTTPS on the deployed VMs and the laptop fallback start procedure tested.

## Requirements

- LE-1: Two Oracle Arm VMs, VM-P and VM-I, with a private link, key-only SSH and only ports 80 and 443 public (ADR 0007, 0010; D-34; NFR-ISO-06).
- LE-2: DuckDNS names for the platform and for the labs, a certificate for the platform host and a wildcard certificate for instances by DNS-01 (D-28; ADR 0003; NFR-SEC-06).
- LE-3: The Vercel project is created, with the rewrite configuration taken from initiative-platform epic-platform-baseline entry 7, the origin secret and an origin-secret check in the platform Caddy; spike S-14 (SSE through a Vercel rewrite) runs here against the real VM (D-28; ADR 0002).
- LE-4: Images build in CI for amd64 and natively for arm64 on the VM (D-28; ADR 0011; NFR-POR-02).
- LE-5: Encrypted backups to Oracle Object Storage with a tested restore; the restore test is also used by initiative-platform epic-privacy-audit-and-keys (D-28; NFR-AVL-05).
- LE-6: Keep-alive, budget alert, named account owner and access for all three developers (OI-8, OI-32 follow-up; NFR-AVL-01, NFR-CST-01).
- LE-7: The laptop fallback starts the same stack with configuration only (NFR-AVL-02, NFR-POR-01; ADR 0015).
- LE-8: Spikes S-1, S-11, S-16 and S-17 are run and recorded (certificate, Oracle shape, DuckDNS wildcard, private link).

## Done when

1. The platform and a stub instance are reachable over HTTPS on VM-P and VM-I, and the instance VM accepts only 80, 443 and key-only SSH from the internet.
2. A real Let's Encrypt certificate for the platform host and a wildcard certificate for the labs name are issued and renew automatically.
3. A backup restore test succeeds and the account owner, budget alert and keep-alive routine are written down.
4. The laptop fallback start procedure is documented and tested on Tanmay's PC.
5. The Oracle terms-of-service email is sent and the reply is kept (R-4).

## Boundaries

Hosting, DNS and TLS, CI image builds, backups and the fallback. Not the application code of any stream and not the orchestrator's internal hardening (epic-isolation-and-hardening).

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- architecture, docs/architecture/02-deployment-and-network.md; docs/architecture/03-origins-and-access.md
- decision, initial.md D-15, D-16, D-28, D-34
- constraint, docs/prd/PRD.md section 6.5 (availability) and 6.10 (cost)

## Notes

- Waits on initiative-platform epic-platform-baseline entries 5 and 7 (API and dashboards skeletons) for the first real deployment; until then it deploys the stub instance only.
- Open question: which developer owns the Oracle account and how the others get access (OI-8); the free web address route (OI-9).
- Unknown: DuckDNS wildcard A-record resolution (S-16); two-VM private link (S-17); Oracle capacity and idle reclaim on both VMs (S-11).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
