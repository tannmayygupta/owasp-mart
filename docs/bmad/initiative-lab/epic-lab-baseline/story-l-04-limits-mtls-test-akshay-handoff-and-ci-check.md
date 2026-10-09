---
id: 10
type: story
title: "L-04 limits: mTLS test, Akshay handoff and CI check"
parent: epic-lab-baseline
covers: [LB-5]
after: [4]
hitl: true
risk: medium
---

# L-04 limits: mTLS test, Akshay handoff and CI check

## Description

Closes three limits left by story 4. A test shows the orchestrator client works over mutual TLS against the fake orchestrator with a throwaway certificate authority made inside the test (no key or certificate committed). A team-chat message and a HANDOFFS.md row tell Akshay about the open points of IF-5, the apps/api skeleton and ADR 0018. The CI result of the pull request is read, failures are fixed and the real result is recorded. A person opens the pull request and pastes the message.

## Acceptance Criteria

Verify: The mTLS tests pass with real output (a client without a certificate, with the wrong authority or for another host name is refused); the message and the handoff row exist; CI of the pull request is green, or each failure is fixed and recorded.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
