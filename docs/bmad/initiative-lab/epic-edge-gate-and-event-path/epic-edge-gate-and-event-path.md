---
type: epic
title: "Only the owner reaches an instance, and events reach the platform"
parent: initiative-lab
covers: [FR-INS-10, FR-SES-11]
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Only the owner reaches an instance, and events reach the platform

## Description

The labs edge terminates TLS for instance hostnames, a gate admits only the owner with a ticket and a host-only cookie, routes to the right sidecar, blocks frozen or closed instances, and relays signed sidecar events to ingest without giving instances any route to the platform.

## Outcome

Players reach only their own instance over HTTPS and the platform receives their events safely; the signal is FR-INS-10 and FR-SES-11 passing and the network contradiction of D-23 resolved in practice.

## Requirements

Numbered source: docs/prd/PRD.md (FR-INS-10, FR-SES-11) plus the access and network design in ADR 0003, 0004 and 0005 (D-28).

## Done when

1. A second account, or an edited hostname, cannot reach another user's instance; a frozen or closed instance refuses requests at the edge.
2. No instance container publishes a host port and instances never initiate a connection to the platform.
3. A signed event from a sidecar reaches ingest through the edge relay and a forged or replayed event is rejected.
4. The edge is attached to many instance networks without trouble (spike S-15) and routes only a strict hostname pattern to a sidecar alias.
5. Deployed and verified on the VMs through epic-environments-and-deployment.

## Boundaries

The labs edge, the gate and the relay. Not the sidecar internals (epic-flags-detection-and-sidecar).

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- prd, docs/prd/PRD.md, section 5.5 and 5.4
- decision, initial.md D-28
- architecture, docs/adr/0004-instance-access-gate.md; docs/adr/0005-instance-network-and-event-path.md

## Notes

- Decision: the edge acts as the event relay (ADR 0005); a separate collector container is the alternative if the edge proves too exposed.
- Open question: instance access gate design (ADR 0004) still awaits the user.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
