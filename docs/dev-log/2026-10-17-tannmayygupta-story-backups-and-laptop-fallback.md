# Backups and laptop fallback: encrypted dump, restore test, one-command fallback (story 8.4, L-24 lean)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet (working tree) |
| Status | Partly done: local proof done; every live step (VM backup, scp, S3, restore on a VM) is a runbook step not yet run |
| Report tag | Operations: backup and recovery, demo resilience |

## Requirements covered
LE-5 (backup with tested restore), LE-7 (laptop fallback); D-96, D-98 (both Proposed in the epic plan, not yet confirmed); ADR 0015 (laptop fallback engine).

## Summary (plain language, 3-5 lines)
`scripts/backup.mjs` takes a dump of the platform Postgres, encrypts it with openssl AES-256 (PBKDF2), writes a SHA-256 file and a manifest, and `restore-test` proves the file restores into a scratch database with equal row counts. `scripts/fallback.mjs` starts, checks and stops the platform stack on Docker Desktop in one command. Two runbooks give you the VM, scp and S3 steps. Everything ran on this PC; nothing ran on a VM or in AWS.

## Why
A backup nobody has restored is a hope, and the demo of 19 Oct needs a way to carry on when the deployed site or a VM fails. Hosting moved from Oracle to AWS (D-41), so the Oracle Object Storage target of L-24 is dropped.

## What was built
- `scripts/backup.mjs`: commands `backup`, `verify`, `restore-test`. Pass phrase only from a file outside the repository; the output folder must be outside the repository; manifests hold table names and row counts only.
- `scripts/fallback.mjs`: `up [--no-web] [--lab]`, `check`, `down`, Compose project `vulnmart-fallback`. `--lab` starts the ingest entrypoint as the lab runtime and refuses while `apps/api/src/vulnmart/lab` does not exist.
- `docs/runbooks/backup-restore.md`, `docs/runbooks/laptop-fallback.md`.

## How it works
Backup: `docker exec <postgres> pg_dump -Fc` piped in memory to `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:<file>`. The ciphertext hash goes in `<file>.sha256` and the manifest. `restore-test` checks the hash first (before any decryption), decrypts, compares the plain hash with the manifest (catches a wrong pass phrase for sure, because CBC padding alone can pass by chance), creates `vulnmart_restore_test`, runs `pg_restore`, compares every table's row count, then drops the scratch database and deletes the temporary file in a `finally`. It never targets any other database name.

## Files changed
- `scripts/backup.mjs`, `scripts/backup.test.mjs` (new)
- `scripts/fallback.mjs`, `scripts/fallback.test.mjs` (new)
- `docs/runbooks/backup-restore.md`, `docs/runbooks/laptop-fallback.md` (new)
- `docs/assets/story-8-4-backup-fallback/` (evidence)

## Decisions made
D-98 is the plan's proposal (openssl AES-256-CBC with PBKDF2, checksum in a separate file, `age` as follow-up). No ADR written here: waiting for the developer's confirmation of D-98 (recorded limit: CBC has no authentication of its own). Alternatives (age, GPG) need an install two days before the demo.

## Tests
- `node --test scripts/backup.test.mjs scripts/fallback.test.mjs`: 16 tests, 16 pass, 0 fail (output in `docs/assets/story-8-4-backup-fallback/unit-tests.txt`). Includes a real openssl round trip and a wrong-pass-phrase case.
- Real run on Docker Desktop (Docker 29.6.2), Compose project `vulnmart-fallback`, output in `docs/assets/story-8-4-backup-fallback/backup-fallback-output.txt`: `fallback up --no-web` exit 0; `fallback check` 4 PASS (api healthz, readyz, mailpit, 403 without the origin secret); `backup` of the migrated platform schema plus one seeded test table (7 tables, 41 rows) exit 0; `verify` PASS; `restore-test` PASS (verify, decrypt, restore, 7 tables with equal counts, cleanup); wrong pass phrase FAIL exit 1 with no scratch database created; one flipped byte FAIL (checksum mismatch before decryption); missing manifest FAIL; `fallback down` PASS with 0 containers and 0 volumes of the project left; no scratch database and no temporary file left. An earlier run on a hand-seeded 3-table database also passed (not in the evidence file).
- Traceability rows: LE-5, LE-7 (to be updated by the story owner).

## Evidence
`docs/assets/story-8-4-backup-fallback/backup-fallback-output.txt`, `unit-tests.txt`. They hold counts and PASS/FAIL lines only; no passphrase, hash of a real backup or data.

## Problems met and how they were fixed
- PowerShell 5.1 `Set-Content -Encoding utf8` wrote a byte order mark into two files; the BOMs were stripped (the repository's text check refuses them).
- The evidence capture first contained PowerShell error noise from stderr lines; it was filtered and the cleaned file is the one saved.
- Not a defect: the Postgres container is read-only with a 16 MB tmpfs, so the dump is streamed through the host, not written inside the container. The dump is held in memory (fine for the demo size; a note for big databases).

## Security notes (vulnerable parts only)
Not a vulnerable part. The scripts print no secret; the default dev database password is not used (local socket inside the container).

## Limitations and follow-ups
- NOT done, developer steps: backup on `vm-p`, scp to the laptop, optional S3 copy, restore from the copy (`backup-restore.md` B to D).
- NOT proven: `fallback up` with the dashboards (`web` profile, a longer build) and `--lab` (story 1's lab runtime is not in the tree; the variable name `VULNMART_LAB_DEMO_TOKEN` for the demo token is an assumption to align with story 1).
- Fixed container names in the Compose file mean the fallback and the local demo (`vulnmart-demo`) cannot run together.
- `.gitignore` has no `*.dump*` pattern (the plan asked to check): not changed here, because the script writes outside the repository and refuses a path inside it; add `*.dump.enc*` in a `[no-doc]` commit if you want the extra guard.
- Authenticated encryption with `age` stays a follow-up (D-98 limit).
- Handoff to Akshay (P-06): production Postgres layout assumed to match Compose; the row text is in the story plan.
