---
title: "Tester cannot see the shop login in the Network panel and does not see the Cryptographic Failures hint"
ticket: 1
status: in-review
assignee: "tannmayygupta"
---

## Progress
- 2026-10-20: console fix and tests committed (a3287de). Local checks: challenge exploits 42/42, shop 177 pass, edge 105/105, contracts PASS, API 2586 passed (237 skipped, need Postgres DSN), Docker loop 10/10 and edge e2e 11/11 after two test repairs. Live lab not reproduced. State: in-review, waiting for the developer to confirm done.

