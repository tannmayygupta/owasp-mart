# Runbook: backups of the platform databases and the off-host copy

Story L-24 (FR-PRV, LE-5). Files: `infra/hosts/vulnmart-backup.{sh,service,timer}`, `infra/hosts/vulnmart-alert.{sh}` and `vulnmart-alert@.service`, `scripts/backup-pull.mjs`, `scripts/live-ops-check.mjs`. Installed on the running hosts by `node scripts/live-deploy.mjs hooks`.

## What runs
- vm-p, every day at 02:30 UTC (plus up to 15 minutes), and at the next boot if a run was missed: `vulnmart-backup.service` dumps the platform database (`vulnmart`) and the key store database (`vm_keystore`) with `pg_dump -Fc` into `/var/backups/vulnmart` (mode 600, root only), reads each file back with `pg_restore --list`, writes `/var/lib/vulnmart/backup-ok` and deletes dumps older than 7 days.
- A failure (a dump that fails or is empty or cannot be read back) fails the unit; `vulnmart-alert@.service` then writes `/var/lib/vulnmart/ALERT-vulnmart-backup.service` and a critical journal line. The next good run removes the file. The certificate renewal unit does the same with `ALERT-vulnmart-certs.service`.
- The key store dump holds only wrapped keys. The key encryption key is a secret file that is not in any dump; keep dumps and secrets folder apart.

## Every morning (one command)
`node scripts/live-ops-check.mjs --p ubuntu@<vm-p> --i ubuntu@<vm-i> --platform <platform name> --labs <labs zone>`: no alert file on either host, newest backup at most 26 hours old, both certificates with at least 20 days left. Exit 0 means all fine.

## Off-host copy
`node scripts/backup-pull.mjs --ssh ubuntu@<vm-p>` copies the newest dump of each database to `~/.vulnmart-deploy/prod/backups` on your computer (outside the repository), checks the PostgreSQL header, and keeps the newest 14 of each. Run it after each demo day and before any change to the hosts. A copy to cloud object storage needs a bucket and a role for the host: not built (it would need your account).

## Restore (tested)
1. `sudo docker exec vulnmart-postgres createdb -U vulnmart restore_check`
2. `sudo sh -c "docker exec -i vulnmart-postgres pg_restore -U vulnmart -d restore_check --no-owner < /var/backups/vulnmart/<file>"`
3. Compare: `select count(*) from information_schema.tables where table_schema='public'` and the rows of `users` in both databases.
4. `sudo docker exec vulnmart-postgres dropdb -U vulnmart restore_check`
To restore for real, stop the API and worker first, restore into an empty database, then start them. The result of the test of 2026-10-19: 39 of 39 tables and 45 of 45 users (`docs/assets/production-readiness/l24-backup-live.json`).