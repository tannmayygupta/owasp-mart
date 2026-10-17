# Runbook: encrypted backup and restore test of the platform database (story 8.4, L-24 lean)

Goal: a backup you have restored at least once. `scripts/backup.mjs` dumps the platform Postgres, encrypts it, writes a checksum and a manifest, and proves the file restores into a scratch database with equal row counts.

What is proven and what is not: on 17 Oct 2026 the commands below ran on Tanmay's PC against the Compose stack on Docker Desktop (evidence `docs/assets/story-8-4-backup-fallback/backup-fallback-output.txt`). **Nothing was run on the VMs or in S3.** Steps marked LIVE are yours; no result exists until you report it.

## How it works (short)
- `backup` runs `pg_dump -Fc` inside the Postgres container (`docker exec`), encrypts it with `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt` using a pass phrase read from a file, and writes `vulnmart-<UTC time>.dump.enc`, `<file>.sha256` (hash of the encrypted file) and `<file>.manifest.json` (time, sizes, table names with row counts, hash of the plain dump; counts only, no data).
- `verify` checks the SHA-256 before anything is decrypted.
- `restore-test` verifies, decrypts to a temporary file, creates the scratch database `vulnmart_restore_test` inside the same container, runs `pg_restore`, compares every table's row count with the manifest, then drops the scratch database and deletes the temporary file (also when something fails). It refuses to touch any other database name.
- Defaults: container `vulnmart-postgres`, user `vulnmart`, database `vulnmart` (the Compose service). The scripts use local socket access inside the container; no password is passed or printed.
- Limit (D-98): AES-CBC alone does not detect tampering. Tampering is caught by the SHA-256 file, so copy the `.sha256` file by a different route than the dump (for example paste its one line into the team chat or password manager). A wrong pass phrase is caught by the plain-dump hash in the manifest. `age` (authenticated encryption) is the recorded follow-up.

## Pass phrase
Make a long random pass phrase once, outside the repository, and keep a copy in your password manager.
```powershell
New-Item -ItemType Directory -Force $HOME\vulnmart-backup | Out-Null
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_}) | Set-Content -NoNewline $HOME\vulnmart-backup\pass.txt
```
The script refuses a pass file inside the repository, an empty one, or a missing one. Never put the phrase in an argument, an environment variable, a chat or a commit.

## A. Local proof (Docker Desktop, any time)
```powershell
node scripts/dev.mjs up platform            # or: node scripts/fallback.mjs up --no-web
node scripts/backup.mjs backup --out $HOME\vulnmart-backup\out --pass-file $HOME\vulnmart-backup\pass.txt
$f = (Get-ChildItem $HOME\vulnmart-backup\out -Filter *.dump.enc | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
node scripts/backup.mjs verify --file $f
node scripts/backup.mjs restore-test --file $f --pass-file $HOME\vulnmart-backup\pass.txt
```
Expected: `PASS` lines for backup, verify, decrypt, restore, compare and cleanup, exit code 0. Then `node scripts/dev.mjs down` (or `node scripts/fallback.mjs down`).

Negative checks you can repeat: a wrong pass file gives `FAIL decryption failed (wrong pass phrase?)` and no scratch database is created; one flipped byte gives `FAIL verify: checksum mismatch` before any decryption; a removed manifest gives `FAIL verify: manifest missing`.

## B. LIVE: back up on the VM that holds Postgres (vm-p)
Assumption (H to Akshay, P-06): production Postgres runs as the same Compose service layout as locally (container `vulnmart-postgres`). If it is anywhere else (managed database, other container name) tell me before using this; pass `--container`, `--user`, `--db` if only the names differ.

1. SSH to `vm-p` with your own key. Get the script and Node 24 on the host (the repository has no git egress on the VMs: `git archive HEAD scripts/backup.mjs | ssh <user>@<vm-p address> "tar x"` from your PC, then `node --version` on the host).
2. Create the pass file on the host (owner only): `install -m 600 /dev/null ~/backup-pass.txt` then paste the phrase into it with an editor. Delete it after the run (`shred -u ~/backup-pass.txt`).
3. Run: `node scripts/backup.mjs backup --out ~/backups --pass-file ~/backup-pass.txt` and `node scripts/backup.mjs verify --file ~/backups/<file>`.
4. Do the restore test on the host as well: `node scripts/backup.mjs restore-test --file ~/backups/<file> --pass-file ~/backup-pass.txt`. It uses a scratch database inside the same Postgres container and drops it again. Record the six PASS lines (no addresses).

## C. LIVE: copy the encrypted file off the VM
Minimum (to your laptop, outside the repository):
```powershell
scp <user>@<vm-p address>:backups/vulnmart-<time>.dump.enc* $HOME\vulnmart-backup\from-vm\
```
Keep the `.sha256` line also somewhere else (see the limit above). Optional, to a private S3 bucket with server-side encryption (your AWS window, profile line first, output filtered, no account id or address in anything you paste):
```powershell
$env:AWS_PROFILE = "vulnmart"
aws s3 cp $HOME\vulnmart-backup\from-vm\vulnmart-<time>.dump.enc s3://<your private bucket>/backups/ --sse AES256
aws s3 ls s3://<your private bucket>/backups/ --query "Contents[].[Key,Size]" --output text
```
Never make the bucket public. The bucket and its lifecycle rule are your choice (Oracle Object Storage is dropped with the Oracle hosting).

## D. LIVE: restore on the laptop from the copy
```powershell
node scripts/dev.mjs up platform
node scripts/backup.mjs restore-test --file $HOME\vulnmart-backup\from-vm\vulnmart-<time>.dump.enc --pass-file $HOME\vulnmart-backup\pass.txt
```
`restore-test` restores into the scratch database only and drops it. To keep the data in a real database for the fallback, do it by hand and only on a throwaway laptop stack: decrypt with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:<pass file> -in <file> -out restored.dump` (put `restored.dump` outside the repository), `docker exec -i vulnmart-postgres pg_restore -U vulnmart -d vulnmart --clean --if-exists --no-owner --no-acl < restored.dump`, then delete `restored.dump`. The fallback normally runs on in-memory lab state and does not need production data (D-96).

## What to save as evidence (docs/assets/story-8-4-backup-fallback/)
The PASS and FAIL lines of steps B and D (no host names, addresses or file paths with your user name), the manifest's table names and counts if you want them, nothing else. Not the dump, not the pass phrase, not the checksum file of a real backup.

## When it fails
- `container ... is not running`: start the stack (`node scripts/dev.mjs up platform`) or pass `--container`.
- `pg_dump failed`: the user or database name differs; pass `--user` and `--db`.
- `FAIL cleanup: could not drop vulnmart_restore_test`: drop it by hand, `docker exec vulnmart-postgres dropdb -U vulnmart vulnmart_restore_test`.
- `openssl` not found on Windows: Git for Windows ships it (`C:\Program Files\Git\usr\bin` or `mingw64\bin`); put that folder on the PATH.
