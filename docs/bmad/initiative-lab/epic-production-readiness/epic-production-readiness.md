---
type: epic
title: "The lab is persistent, served by the real API, runs real instances and its review findings are closed"
parent: initiative-lab
covers: []
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Production readiness of the lab

## Description

After the sprint 3 and 4 review the lab's engines worked only in memory, behind token-guarded demo routes, with the instances proven only on stub images. This epic makes the lab real: its state is in Postgres, the IF-2 routes are served by the real API, an instance is created by the orchestrator from the real shop image, the open review findings are closed, and the whole thing is verified on the deployed hosts.

## Outcome

A learner can sign up, start a real instance, capture a flag, see a score, and a restart of any process loses nothing; each of these is proven by a test or a recorded run on the deployed system.

## Done when

1. The lab state is stored in Postgres and survives a restart (tests on a real Postgres).
2. The IF-2 lab routes and the catalogue are served by the API and checked against the contract.
3. An instance created by the orchestrator from the real shop image passes the isolation probe and the flag loop on vm-i.
4. Every confirmed review finding is fixed with a test or recorded as accepted with the reason.
5. The end-to-end suite, the load check, the isolation audit and a backup and restore test pass on the deployed system.

## Boundaries

Stream L work. Where a part belongs to another stream (the invite and company flows of stream P, the shop challenges of stream T) this epic only supplies the lab side and says so.

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md; review record docs/dev-log/2026-10-18-tannmayygupta-sprint-4-review-and-s-8.md
- 2026-10-19: contract versions made true and the tag rule amended, docs/dev-log/2026-10-19-tannmayygupta-contract-versions-and-tag-rule.md (L-09 still open: sign-offs, handoffs, tag)
- 2026-10-19: L-05, L-18, L-26 ticked; L-28 port built; withdraw and undo routes, login bump, live proofs, docs/dev-log/2026-10-19-tannmayygupta-withdraw-undo-login-bump-and-cohort-port.md
- 2026-10-19: follow-up fix on the same pull request (delete_after only while withdrawn), same dev-log
- 2026-10-19: instance limits, flag scan in CI and the time-metrics 500, docs/dev-log/2026-10-19-tannmayygupta-instance-limits-flag-scan-and-time-metrics.md (L-14, L-19, L-25 stay open)
- 2026-10-19: the images workflow change declared in contracts/CHANGELOG.md (contract rules), same pull request
- 2026-10-19: COMPAT.md follows Akshay's P-25 (IF-1 1.1.0, DB 2.1.0), erase repeat test (H-145), docs/dev-log/2026-10-19-tannmayygupta-compat-after-p25-and-erase-repeat.md
- 2026-10-19: Tanmay's own COMPAT.md sign-off rows approved, docs/dev-log/2026-10-19-tannmayygupta-own-signoff-rows.md
- 2026-10-19: FR-TIM-04 events written by the lab, docs/dev-log/2026-10-19-tannmayygupta-attempt-log-events.md (L-25 stays open)
- 2026-10-19: Postgres loop test updated for the new first log lines (same pull request)
