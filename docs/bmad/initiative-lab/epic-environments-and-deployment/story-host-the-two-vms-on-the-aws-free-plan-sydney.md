---
id: 6
type: story
title: "Host the two VMs on the AWS Free Plan (Sydney)"
parent: epic-environments-and-deployment
covers: [LE-1, LE-6, LE-8]
after: [1]
hitl: true
risk: high
---

# Host the two VMs on the AWS Free Plan (Sydney)

## Description

Replaces the live phase of story 1 (Oracle sign-up needs a credit card that nobody has). Moves the hosting to the developer's AWS Free Plan account in Sydney (ap-southeast-2, the region the account can use): a VPC with security groups built from network-rules.json, two Free Plan eligible EC2 hosts (Ubuntu 24.04, Arm t4g.small by default, size as a variable), IMDSv2 required, key-only SSH, only 80, 443 and SSH public, a zero-spend budget and credit alert, the same host baseline and verification scripts, a runbook, decision D-41 and an updated ADR. A person does the account, IAM user and apply steps; the account owner stays Tanmay. No keep-alive service (AWS does not reclaim idle instances, to confirm).

## Acceptance Criteria

Verify: Both hosts are reachable by key-only SSH; only 22, 80 and 443 respond from outside; the private link works with mutual TLS; the budget alert and credit check are set; the live results are recorded.

## References

- parent — docs/bmad/initiative-lab/epic-environments-and-deployment/epic-environments-and-deployment.md
