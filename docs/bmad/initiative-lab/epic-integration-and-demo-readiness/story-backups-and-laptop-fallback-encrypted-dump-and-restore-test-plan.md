---
title: 'Backups and laptop fallback: encrypted dump and restore test, one-command fallback start'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/runbooks/local-demo.md', '{project-root}/docs/runbooks/aws-account-and-vms.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** L-24 asks for encrypted backups with a restore test and a laptop fallback. The plan of record said Oracle Object Storage, but hosting moved to the AWS Free Plan in Sydney (D-41), and there is a hard demo date. Without a tested restore a backup is only a hope, and without a one-command fallback a dead VM or a bad network ends the demo.

**Approach:** Two small Node scripts (built-ins only, `child_process` for `docker`, `openssl`) and two runbooks.
- `scripts/backup.mjs` with three commands. `backup --out <dir> --pass-file <file>`: runs `docker exec <postgres container> pg_dump -Fc -U <user> <db>` (container name and credentials from the Compose service environment, read from `infra/compose/compose.yaml` defaults, never printed), pipes it through `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:<pass-file>` into `<out>/vulnmart-<UTC timestamp>.dump.enc`, then writes `<file>.sha256` (hash of the ciphertext) and a small `.manifest.json` (UTC time, table names with row counts, byte size; counts only, no data). `verify --file <f>`: checks the SHA-256 first and refuses on a mismatch before any decryption. `restore-test --file <f> --pass-file <p>`: verify, decrypt to a temporary file, `createdb` a scratch database `vulnmart_restore_test` inside the same container, `pg_restore` into it, compare the row counts of every table with the manifest, drop the scratch database and delete the temporary file; exit 0 only when every count is equal.
- `scripts/fallback.mjs` with `up`, `check` and `down`: `up` starts the platform stack (Compose project `vulnmart-fallback`, profiles `platform` and `web`), then the lab runtime process (`uvicorn ... ingest:app` with the four lab variables, random token, `FakeInstanceHost` unless `--real-orchestrator` is given, in which case it starts the orchestrator as `demo.mjs` does), then prints the local URLs and the demo token file path; `check` calls the health routes and one demo route and prints PASS or FAIL lines; `down` stops only what `up` started (label and project name) and removes the temporary files.
- Runbooks: `docs/runbooks/backup-restore.md` (the developer's steps: run the backup on the VM that holds Postgres, copy the encrypted file to the laptop with scp and, optionally, to a private S3 bucket with server-side encryption using `aws s3 cp`, restore into a scratch database on the laptop; commands written with the profile line first and filtered outputs, none applied by Claude) and `docs/runbooks/laptop-fallback.md` (when to switch: the decision table of story 6, the exact commands, what works in the fallback and what does not).

**Proposed (decided on the developer's delegation):**
- **D-98:** backups use `pg_dump` custom format encrypted with `openssl enc` AES-256-CBC with PBKDF2 (600000 iterations) and a SHA-256 manifest checked before decryption, because openssl is already required by the repository's tests and is on every VM, Windows (Git for Windows) and Docker image the team uses; `age` or GPG are better tools but need a new install two days before the demo. Authenticity comes from the checksum kept in a separate file and the restore test, not from the cipher mode: the checksum file is copied by another path than the dump (note this limit in the runbook; proper authenticated encryption with `age` is a recorded follow-up). The passphrase lives in a file outside the repository (and in the developer's password manager), never in an environment variable, argument or log. The destination of the live copy is the developer's choice between scp to the laptop (minimum) and S3; Oracle Object Storage is dropped with the Oracle hosting. The laptop fallback is the same stack on Docker Desktop with in-memory lab state (D-96) and stub or shop instances: it demonstrates the product, it does not restore production data.

## Boundaries & Constraints

**Always:** the passphrase file path is an argument and the file is never read into an error message; the dump never touches the repository folder (default output outside it, and `.gitignore` already blocks `*.dump*`: check, add the pattern only if missing in a `[no-doc]`-safe way and say so); counts and sizes only in manifests and logs; the scratch database and the temporary plaintext file are removed even on failure (`finally`); `restore-test` refuses to run against a database named anything but the scratch name; `down` removes only objects of its own Compose project.

**Never:** AWS, S3 or ssh commands run by Claude (they are runbook text for the developer); writing a passphrase, key, connection string with a password or a dump into the repository, the dev-log or the evidence (the evidence holds counts and PASS lines); touching the demo project `vulnmart-demo` or other containers and volumes; changing compose files, migrations or Akshay's database code (the schema comes from the existing `migrate` service); the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Backup | stack up, schema migrated | encrypted file, `.sha256`, manifest with counts | none |
| Restore test | good file and pass file | scratch DB restored, all counts equal, scratch dropped | none |
| Wrong passphrase | other pass file | restore-test fails with "decryption failed", scratch DB never created | non-zero exit, temp file removed |
| Changed byte | one byte flipped in the file | `verify` fails on the checksum before decryption | non-zero exit |
| Missing manifest | manifest absent | refuses | non-zero exit |
| Stack down | no postgres container | clear message, nothing created | non-zero exit |
| Fallback up | Docker Desktop on | platform and runtime healthy, URLs printed | on failure `down` cleans what started |
| Fallback down | after up | none of the project's containers, networks, volumes or processes remain | none |
| Port busy | 3000, 8000 or the runtime port | stops before starting, names the port | none |

</frozen-after-approval>

## Code Map

- `infra/compose/compose.yaml` -- `postgres` service (user, database, container name), profiles `platform`, `web`; `scripts/dev.mjs` (`COMPOSE_FILE`, `run`, `portFree`, `dockerRunning`); `scripts/demo.mjs` (orchestrator start, `demoDown` pattern, temp-file handling).
- `apps/api/migrations/` and the `migrate` service -- schema for the restore test (read only).
- `apps/api/src/vulnmart/lab/` (story 1) -- the runtime the fallback starts.
- `docs/runbooks/aws-account-and-vms.md`, `docs/runbooks/deploy.md` -- style of developer steps; memory rule: AWS commands start with the profile line, filtered outputs, no addresses.
- New: `scripts/backup.mjs`, `scripts/backup.test.mjs` (pure parts: argument parsing, manifest build and compare, checksum, command construction without running them), `scripts/fallback.mjs`, `scripts/fallback.test.mjs`, `docs/runbooks/backup-restore.md`, `docs/runbooks/laptop-fallback.md`.
- docs: dev-log, CHANGELOG, traceability LE-5 and LE-7, evidence `docs/assets/story-8-4-backup-fallback/`, handoff row.

## Tasks & Acceptance

**Execution:**
- [ ] `backup.mjs` pure parts and tests, then the three commands
- [ ] local restore test on the Compose stack with a few seeded rows (insert test rows through `psql`, never real data), flip-a-byte and wrong-passphrase checks, record real output
- [ ] `fallback.mjs` pure parts and tests, then `up`, `check`, `down` run once on Tanmay's PC
- [ ] the two runbooks with every developer command and the evidence to save
- [ ] docs -- handoff, dev-log, CHANGELOG, traceability, story `built` (live backup to S3 and VM restore remain "not done" until the developer reports them)

**Acceptance Criteria:**
- Given the local stack with seeded rows, then `backup` then `restore-test` exits 0, the row counts are equal and no scratch database or temporary file remains.
- Given a flipped byte or a wrong passphrase, then the script fails and says which check failed.
- Given Docker Desktop, then `fallback up`, `check`, `down` leave nothing of project `vulnmart-fallback` behind.
- Given the runbooks, then a developer can run the live backup, the copy and the fallback switch from the text alone.

## Handoffs (proposed, add rows in the same commit)

- To Akshay (P-06 database): the backup assumes the Compose `postgres` service and the Alembic head as the schema; tell me if production Postgres is anywhere else (managed, other container name) before the live backup runbook is used. Default if no answer: same container layout as Compose on VM-P.

## Verification

**Commands:**
- `node --test scripts/backup.test.mjs scripts/fallback.test.mjs`
- `node scripts/backup.mjs backup --out <folder outside the repository> --pass-file <file>` then `restore-test` (Docker Desktop, platform stack up; the exact lines are in the runbook)
- `node scripts/fallback.mjs up`, `check`, `down` (Docker Desktop)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
