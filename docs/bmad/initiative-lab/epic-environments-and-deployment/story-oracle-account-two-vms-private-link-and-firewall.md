---
id: 1
type: story
title: "Oracle account, two VMs, private link and firewall"
parent: epic-environments-and-deployment
covers: [LE-1, LE-6, LE-8]
after: [1.1]
hitl: true
risk: high
---

# Oracle account, two VMs, private link and firewall

## Description

Creates the Oracle Cloud account owned by Tanmay, the two VMs (VM-P and VM-I) in one VCN with a private link, key-only SSH with all three developers' keys, only ports 80 and 443 public, a budget alert, a keep-alive routine, and sends the Oracle terms-of-service email. Records spikes S-11 (shape and capacity) and S-17 (private link) and the account owner, alert and routine. A person does the account and console steps; scripts and a runbook make host hardening and the checks repeatable.

## Acceptance Criteria

Verify: Both VMs are reachable by key-only SSH; only 80, 443 and SSH are open from the internet; the private link works between the VMs; the owner, budget alert and keep-alive routine are written down; the terms-of-service email is sent and its reply kept.

## References

- parent — docs/bmad/initiative-lab/epic-environments-and-deployment/epic-environments-and-deployment.md
