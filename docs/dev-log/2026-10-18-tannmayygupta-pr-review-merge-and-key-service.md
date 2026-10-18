# PR review of sprint-4-tanmay against main: merge fixes and the key service switch

Developer: tannmayygupta. Date: 2026-10-18. Branch: sprint-4-tanmay.

## Requirements covered
FR-PRV-12 (key service), FR-SES-02, FR-SES-10, NFR-SEC-04, D-98 follow-up; handoff H-137 (answered).

## Summary (plain language, 3-5 lines)
Before opening the pull request I merged main into the branch and reviewed the result. Two real problems showed up. Both branches had a migration called 0005, so the chain was broken. And Akshay's key service (P-17, a separate keystore database) already existed, while I had built a second, weaker one in the main database. The lab now uses his, and my migration is 0008.

## Why
A pull request that merges two migration histories with the same id, or two key implementations that disagree about where keys live, would break the first real deployment and weaken the privacy design (keys apart from data, shredding without touching data).

## What was built
- Merge of origin/main (6 commits, Akshay's P-15, P-16, P-17) with conflicts resolved: CHANGELOG (both kept), main.py (lab mount plus mfa and consent routers), test_kernel_settings (new head 0008 and the union of tables), test_kernel_postgres (dynamic head).
- Lab-state migration renamed 0005 to 0008, now revising 0007.
- attempts added to the data inventory of tests/test_data_minimum.py (P-16 test failed without it: the table holds a user id).
- The lab runtime now takes its keys from `key_port_from(Settings())` (DbKeyPort over vm_keystore). `vulnmart.lab.keys` (StoredKeyPort) is deleted; its tests are replaced by tests on a real keystore database (test_lab_pg.py `keystore_engine`), and Akshay's tests already cover the key service itself.
- Deployment: platform compose runs `python -m vulnmart.kernel.migrate` (creates vm_keystore and its role), the API gets VULNMART_KEYSTORE_DSN, KEK and the three masters as files; deploy-secrets makes event_master, flag_key, owner_key, kek and keystore_password; live-deploy stages them.

## Tests
- Merged tree before the key switch: apps/api 2061 passed, 4 skipped (Valkey not set) with Postgres 18 enabled.
- After the key switch: tests/test_lab_pg.py, test_lab_runtime.py, test_kernel_settings.py, test_keys.py, test_keys_postgres.py, test_lab_api.py: 117 passed. Deploy script tests and vmi-audit: 33 passed.
- A full run of everything after the key switch was NOT completed in this entry (see limitations).

## Problems met and how they were fixed
Two migrations with revision id 0005 (renamed mine). The privacy inventory test failing on attempts (added). A first guess at the test database user failed; the real credentials come from the container's environment.

## Deployed result (same day, after the developer approved stopping vm-p and recreating its database)
- vm-p stopped, its Postgres volume removed, the new build started: migrate job created the schema to head 0008 and the keystore database vm_keystore (own role); the data database holds no key table (0 of deks and shredded), vm_keystore holds deks, keystore_schema and shredded.
- First start failed: VULNMART_ENV=production needs a field key since Akshay's MFA code (P-15) was merged. Added field_secret (64 hex, made by deploy-secrets, mounted in api and worker). Second start healthy.
- Deployed journey (scripts/e2e-live.mjs): 29 PASS, 0 FAIL (docs/assets/production-readiness/e2e-run6-new-key-service.json).
- Suites after the key switch: npm test 1030 passed, 2 skipped; orchestrator 467 passed; py-attempts 357 passed; apps/api run with Postgres enabled (see the pull request).

## Independent review of the whole diff (a reviewer that had not seen my reasoning) and what happened to each finding
Fixed, each with a regression test:
1. BLOCKER Withdrawal did not erase what it claimed: no key shred, a failed purge was never retried, rows of replaced instances survived. Now `LabRuntime._erase` shreds the key first, purges, then marks the attempt purged; `tick` finishes any deleted attempt not yet purged; replaced or removed instances drop their events, activity, bot visits and epochs (tests: test_a_deleted_attempt_loses_its_key..., test_the_rows_of_a_replaced_instance...).
2. MAJOR Captured request bodies sat in clear in `events.event`. Now the event row keeps metadata and the body length only; the body exists only sealed in `evidence` (test_a_capture_body_is_never_kept_in_the_events_table).
3. MAJOR Instance leak if the API stopped midway through a start. A retried start now destroys the instance of the stale directory row first (test_a_start_that_died_midway...).
5. MAJOR App role broader than the code needs. Narrowed in migration 0008: attempts no DELETE; evidence and instance_epochs no UPDATE; events only UPDATE (digest, engine_seen); proved by a parametrized permission-denied test.
10. Reviewer refusals (ReviewFinal, ReviewForbidden, NotHeld) were unmapped 500s; now 409/404 like the integrity-flag route.
9. Reverse tabnabbing: the console clears window.opener before sending the ticket URL to the vulnerable lab shop.
12. deploy-secrets --force could destroy every key silently: now needs --destroy-keys too when a kek exists.
13. origin_secret was world readable (444): now 65532:0 mode 440.
14. Daemon id and host name redacted in the committed audit inputs.
15. Stale docs: runtime docstring, the earlier dev-log line (marked superseded).
16. The console offered Start for cancelled and withdrawn attempts, which the API refuses: button removed for them.
17. CI had no Postgres, so the database tests were skipped there: a Postgres service and the app role step were added to the api tests job (not yet run on GitHub: it runs when the branch is pushed).

Corrected, not fixed:
4. The :9444 listener was documented as mutual TLS but is server TLS. Only the labs subnet can reach it (security group and network ACL, tested in Terraform) and every request is signed. The comment now says so; mutual TLS (client certificates for the edge and the orchestrator) is a follow-up.

Not fixed tonight, with the reason:
6. Placeholder consent id on an attempt: the rule for practice attempts is Akshay's decision (handoff H-349 asks; default: no consent for practice).
7 and 8. Locks and counters are per API process and one lock covers orchestrator calls: harmless with the one API container deployed; a limit to lift before running two API processes.
11. Reviewer checks key on role rather than attempt mode, and the session has no org id yet; the org-scoped reviewer path cannot run end to end until stream P adds company scope.

## Tests
- Merged tree before the key switch: apps/api 2061 passed, 4 skipped.
- After the key switch and before these fixes: apps/api 2060 passed, 4 skipped; npm test 1030 passed (2 skipped); orchestrator 467; py-attempts 357.
- After the fixes: see the pull request (full runs are repeated after the final merge of main).

## Deployed result (after the developer approved stopping vm-p and recreating its database)
- vm-p stopped, its Postgres volume removed, the new build started: the migrate job created the schema to head 0008 and the keystore database vm_keystore (own role); the data database holds no key table, vm_keystore holds deks, keystore_schema and shredded.
- First start failed: VULNMART_ENV=production needs a field key since Akshay's MFA code (P-15) was merged. Added field_secret. Second start healthy.
- Deployed journey (scripts/e2e-live.mjs): 29 PASS, 0 FAIL (docs/assets/production-readiness/e2e-run6-new-key-service.json).

## Limitations and follow-ups
- The backup script and runbook dump only the vulnmart database. The wrapped keys live in vm_keystore: a backup of data without the keys cannot be decrypted, and a backup that keeps the keys defeats shredding. The team must decide (the keystore runbook is Akshay's).
- Flags and event keys changed with the new masters; the old test attempts are gone with the old database.
- The fixes above are not yet on the deployed vm-p (see the pull request for the redeploy).