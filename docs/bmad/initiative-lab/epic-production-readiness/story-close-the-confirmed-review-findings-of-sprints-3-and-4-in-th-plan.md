---
title: 'Close the confirmed review findings of sprints 3 and 4 in the runtime, attempts, edge, sidecar and infrastructure scripts'
type: 'feature'
ticket: '3'
created: '2026-10-18'
status: 'done'
baseline_revision: '7c4cc4f'
route: 'full'
risk: 'medium'
---

## Intent
Close the confirmed findings of the sprint 3 and 4 review.

## Result
Done: every finding is fixed with a regression test or accepted with a written reason (docs/dev-log/2026-10-18-tannmayygupta-production-readiness-review-findings.md). Accepted on purpose: B9, C3, C4, C5, C8 and the proxy filter of D11 (a compensating audit check was added).

## Update after the independent PR review (2026-10-18)
An independent review of the whole diff found one blocker (withdrawal did not shred the key or retry a failed purge) and several majors; all are fixed with tests except the ones listed as corrected or deferred in docs/dev-log/2026-10-18-tannmayygupta-pr-review-merge-and-key-service.md. Story stays done.
