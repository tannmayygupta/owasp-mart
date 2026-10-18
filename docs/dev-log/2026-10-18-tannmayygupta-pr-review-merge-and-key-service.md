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

## Limitations and follow-ups
- The deployed vm-p still runs the OLD build with the old key class and the old migration ids. The new build is on vm-p as an image and the new secret files exist locally, but the platform was not restarted: stopping the live service and removing its database volume was denied by the permission classifier and waits for the developer. The database must be recreated (the stored revision id 0005 means something else on main now).
- Flags and event keys change with the new masters; no live attempt survives the switch (test data only).
- Full npm test, orchestrator and py-attempts suites were not re-run after the key switch (the run was blocked); they were green before it and the switch touches only the API and deploy scripts.