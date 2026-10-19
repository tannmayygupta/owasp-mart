# Open lab tasks closed with live proof: reaper and kill test, certificate renewal and alert, backups, vm-i scan

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-ops-backups-alerts-proofs |
| Status | Done for L-10, L-14, L-19, L-24; L-12, L-25, L-29, L-08, L-31 not done (reasons below) |
| Report tag | lab, L-10, L-14, L-19, L-24 |

## Requirements covered
L-10 (LE-2, S-16), L-14 (FR-INS-03, 04, 05), L-19 (FR-FLG-08), L-24 (LE-5, LE-7, LE-8).

## Summary
The developer approved four kinds of change on the live hosts and I made and proved each.
- **L-14:** three throwaway instances with limits of 3 minutes idle, 4 minutes total and the production defaults: the first two were destroyed by the reaper within five minutes, the control lived. Then the orchestrator was restarted on vm-i while an instance was still provisioning: the reconciler adopted the running instance, marked the half-made one failed and removed its containers (0 left).
- **L-10:** a failed unit now leaves an alert file and a critical journal line (`vulnmart-alert`), and a good run clears it; one real renewal was forced on vm-i through the real unit: the serial changed, Caddy restarted, no alert.
- **L-24:** a daily backup of the platform and key store databases on vm-p with a read-back check and 7-day retention, an off-host copy to the developer PC, and a restore into a scratch database: 39 of 39 tables, 45 of 45 users.
- **L-19:** logs, inspect output, the orchestrator and gate logs and the deployed shop image of a running instance on vm-i hold no flag pattern; the CI image scan was already green.

## Why
The 2026-10-19 status table listed these as unfinished: reaper not seen live, no kill test, no forced renewal or alert, no backup schedule or off-host copy, no scan of a running instance.

## What was built
- `infra/hosts/vulnmart-alert.sh`, `vulnmart-alert@.service`, `vulnmart-backup.{sh,service,timer}`; `OnFailure` and a clear step in `vulnmart-certs.service`; `live-deploy.mjs hooks` installs them (alert on both hosts, backup on vm-p).
- `scripts/backup-pull.mjs` (off-host copy), `scripts/live-ops-check.mjs` (one-command morning check), runbook `docs/runbooks/backup-and-restore.md`.

## How it works
`OnFailure=vulnmart-alert@%n.service` runs the alert script for any failed unit; the ops check lists `ALERT-*` files, the age of `backup-ok` and the days left on both certificates (a real TLS handshake).

## Files changed
`infra/hosts/*` (5 new, 1 changed), `scripts/live-deploy.mjs`, `scripts/backup-pull.mjs`, `scripts/live-ops-check.mjs`, tests `scripts/host-ops.test.mjs`, `scripts/backup-pull.test.mjs`, runbook, evidence files, `docs/dev/dev1-tanmay.md`, `docs/traceability.md`, `CHANGELOG.md`.

## Decisions made
The off-host copy goes to the developer's computer (pull over SSH), not to cloud object storage, because the latter needs a bucket and a role in the developer's account. The 60-minute idle limit of the production default was not waited out; the mechanism was proved with 3 and 4 minutes (a control instance with the real defaults is expected to go about 60 minutes after 14:36 local if unused).

## Tests
- `node --test scripts/host-ops.test.mjs scripts/backup-pull.test.mjs` 9 passed (alert script, backup success and failure paths with a fake docker, retention, marker, ops check logic, unit files, hooks wiring); `cloud-hosts`, `certs-host`, `reload-caddy-hook` tests still pass.
- Live runs and their records are in `docs/assets/production-readiness/`: `l14-reaper-live.json`, `l14-kill-test-live.json`, `l10-renewal-live.json`, `l24-backup-live.json`, `l19-vmi-scan.txt`.

## Evidence
The five files above.

## Problems met and how they were fixed
- Remote changes to the live hosts were refused by the permission system until the developer approved each kind; the L-12 deploy of the hello stack was refused and was not run.
- The alert proof used an instance name that did not match the clear call and left an alert file; it was cleared at once, and the ops check showed no alert afterwards.
- The kill test's first create call failed (the orchestrator restarted under it); that is the expected shape of the failure, and what mattered is the cleanup.

## Security notes
No flag value is printed by the scan; dumps are mode 600 on the host and the local copy sits outside the repository; the key store dump holds only wrapped keys.

## Limitations and follow-ups
- Not done: L-12 (the hello stack deploy needs `node scripts/deploy.mjs --manifest <release.json> --target p,i,local --provider aws`, refused to run from here; the images are built and public), L-25 (platform events are stream P's), L-29 (S-8 live sandbox experiments skipped for the demo), L-08 and L-31 (human items).
- The decoy placement in the shop (FR-FLG-07, H-331) is still open; it is not part of the L-19 Done-when.