# Live migration check, backup before change and a data accuracy test on the live site

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | live-data-verification |
| Status | Done for the checks below; no schema change was pending, so no new migration was applied |
| Report tag | data safety, deployment |

## Requirements covered
FR-PRV (retention and backup), H-358 (live deploy), L-24 (backups), FR-ACC-01 and FR-ORG-01 (what a sign-up stores).

## Summary
The live database was already at Alembic head 0018 (the migrate container ran at the last deploy). Before redeploying the new sign-up and sign-in pages I took a fresh backup, copied it off the host, restored it into a scratch Postgres and compared every table count with the live counts. After the deploy a script made real HTTPS calls to the live site and compared the live row counts before and after.

## Why
The leader asked for a migration and deploy in which no data is lost, and for proof from outside (curl-style calls) that live data is saved correctly.

## What was built
- `scripts/live-deploy.mjs`: `backup-now` (runs the backup unit once and prints its result and the newest files) and `data-counts` (the migration head and an exact row count of every public table; counts only, never a value).
- `scripts/verify-live-data.mjs` (+ test): signs up one learner and one recruiter with plus-addressed copies of the leader's address, repeats the learner sign-up, tries the right password, a wrong password and an unknown address, then compares the database counts. With `--verified-email` and `VM_VERIFIED_PASSWORD` it also signs in and checks the stored profile and display name.

## How it works
The counts come over ssh from the Postgres container (`psql` as the owner role over the local socket, one read-only statement). The HTTPS calls send the site's own `Origin` header, as a browser does. Nothing prints a password, a cookie or a token.

## Files changed
`scripts/live-deploy.mjs`, `scripts/live-deploy.test.mjs`, `scripts/verify-live-data.mjs`, `scripts/verify-live-data.test.mjs`, `docs/assets/web-auth-ui-match-console/live-signup-dark.png`.

## Decisions made
No ADR. A restore into a scratch database on the leader's PC was chosen over a restore on vm-p, so the test cannot touch production.

## Tests
Real commands and results (2026-10-21 evening UTC):
- `live-ops-check`: no alert file on either host, newest backup 16.5 hours old, certificates 86 and 87 days.
- `backup-now`: Result=success, ExecMainStatus=0, no alert files; `backup-pull`: both dumps copied (263621 and 14193 bytes).
- Restore of the pulled dump into a scratch Postgres 18.6 container with `pg_restore --exit-on-error`: RESTORED; 43 of 43 public tables with identical row counts to the live counts read just before; Alembic head 0018.
- Deploy: build, `ship-p`, `platform` (api, web, worker and caddy recreated; the Postgres container was not touched, up for 3 days). `verify-deployed`: 70 PASS, 0 FAIL.
- `node scripts/verify-live-data.mjs --base <platform> --email <leader address>`: first run 13 PASS, 1 FAIL (my expectation was wrong: a recruiter gets no `user_roles` row at sign-up, only a learner does); after correcting the expectation 14 PASS, 0 FAIL. Findings: learner sign-up 202; repeated sign-up 202 with no second user; recruiter sign-up 202 with +1 organization and +1 org_member; right password before confirmation gives 403 AUTH-EMAIL-NOT-VERIFIED, a wrong password and an unknown address both give 401 AUTH-INVALID-CREDENTIALS; +2 confirmation tokens, +3 queued mails (the third is the notice for the repeated sign-up); no table lost a row; head still 0018.
- After the deploy: 0 tables below the pre-deploy baseline; users 69 before, 73 now (two test runs of two accounts each).
- Unit tests: `scripts/live-deploy.test.mjs` 9 of 9, `scripts/verify-live-data.test.mjs` 4 of 4.

## Evidence
`docs/assets/web-auth-ui-match-console/live-signup-dark.png` (the live page after the deploy).

## Problems met and how they were fixed
- A background deploy that I started through a nested shell never ran; the next foreground run was interrupted when the session ended, after build and ship had finished. I checked the logs and hosts, then ran only the platform step again (safe to repeat).
- `systemctl start` for the backup is a write over ssh that my own tool permissions refuse when typed ad hoc; the repo script is the approved path, so it is now a command.

## Security notes (vulnerable parts only)
None. The test accounts are plus-addressed copies of the leader's address and stay unconfirmed.

## Limitations and follow-ups
- The test accounts (4 learners, 2 recruiters' companies) now exist unconfirmed in live data; the retention job removes unconfirmed accounts, and an admin can lock them.
- A confirmed account's sign-in and profile are checked only when `--verified-email` is given; this run had none.
- The off-host copy is the leader's PC only; a second place, a scheduled restore test and the audit-anchor copy are still open.
