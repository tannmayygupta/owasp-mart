---
title: 'Deployed verification: platform and lab on vm-p and vm-i, end-to-end suite, load check, audit, backup and restore'
type: 'feature'
ticket: '5'
created: '2026-10-18'
status: 'review'
baseline_revision: '915317e'
route: 'full'
risk: 'high'
---

## Intent
Deploy both profiles and verify them on the real hosts.

## Result (honest state, 2026-10-18)
Done and recorded in docs/assets/production-readiness/: deployed end-to-end journey 29 of 29 (three runs), load 4 and 6 learners, capacity behaviour (HTTP 429 beyond the orchestrator budget), read-only audit 9 PASS 0 FAIL 0 SKIP on saved outputs, backup of the platform Postgres encrypted, checksum-verified and restored into a scratch database with equal row counts for all 27 tables, API restart with equal row counts afterwards.
Open: a fourth journey after the API restart could not run because 7 earlier test instances still held the orchestrator capacity; the cleanup of those test containers on vm-i was denied by the permission classifier and waits for the developer. Waiting for the developer's confirmation before the state is set to done.