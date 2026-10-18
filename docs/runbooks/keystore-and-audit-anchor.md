# Runbook: the keystore, key rotation, shredding and the audit anchor (story P-17)

What this covers: where the per-attempt keys live, how the KEK and the three master keys are provided and rotated, what to do after every shred so that no backup can bring the data back, and how the daily audit anchor is kept off the machine. OI-28 was answered by the developer on 2026-10-18: Postgres and Valkey run self-hosted on VM-P.

What is proven and what is not: the code, the database roles, the shredding rule against a restored copy of the data, and the migrate job were run on a PC against throwaway Postgres 18.6 containers and the Compose stack (see `docs/dev-log/2026-10-18-akshaay29-p17-audit-log-and-key-service.md`). **Nothing below was run on the VMs, with object storage, or with a real scheduler.** Steps marked LIVE are yours; no result exists until you report it.

## The pieces
| Piece | Where | Who can reach it |
|---|---|---|
| Wrapped per-attempt keys | database `vm_keystore`, tables `deks` and `shredded` | role `vulnmart_keys` only (the application's data role `vulnmart_app` cannot connect) |
| KEK (versioned key-encryption keys) | `VULNMART_KEK_FILE`, lines `version:base64` (32 bytes each) | the API process; keep an offline copy |
| Event, flag and owner master keys | `VULNMART_EVENT_MASTER_FILE`, `VULNMART_FLAG_KEY_FILE`, `VULNMART_OWNER_KEY_FILE`, base64 of at least 32 bytes, all different | the API process (the orchestrator never holds the flag key, ADR 0009) |
| Keystore password | `VULNMART_KEYSTORE_PASSWORD_FILE` for the migrate job; the API's `VULNMART_KEYSTORE_DSN` carries it in a secret file too | operator |
| Audit log | tables `audit_log`, `audit_checkpoint`, `audit_anchor` in `vulnmart` | the API appends and reads; nobody changes or deletes through the application |
| Anchor lines | `audit_anchor` (database) and, when `VULNMART_AUDIT_ANCHOR_FILE` is set, a file on VM-P | operator ships the file off the machine |

`python -m vulnmart.kernel.migrate` (the Compose `migrate` service) runs the Alembic history and, when a keystore password is configured, creates the keystore database, its role and its tables. It is idempotent: it can run at every start and it also changes the role's password to the configured one.

## Make the keys (once, outside the repository)
Make each key from 32 random bytes and keep copies in the password manager and offline:
```
python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```
- KEK file: one line, `1:<that text>`. Mode 600, owned by the service user.
- The three masters: one file each, mode 600, **three different values**. The service refuses to start if two are equal or if a value is shorter than 32 bytes.
- **Losing the KEK makes every sealed value unreadable.** The architecture relies on an offline copy (ADR 0009).
- Staging and production do not start with a keystore address but without the KEK or a master (dev and test make random masters, so flags and event keys change at every restart there; never use that outside a laptop).

## Rotate the KEK
1. Make a new key and add a line with the next version to the KEK file (`2:<new>`), keeping the old line. Restart the API: new keys use version 2, old ones still open.
2. Rewrap the old keys: in the API container, `python -c "from vulnmart.main import app; print(app.state.ports.keys.rewrap(batch=500))"`, repeated until it prints 0.
3. Only then remove the old line (version 1) from the file and restart. A key still wrapped with a removed version cannot be opened: that attempt's data is lost.
The master keys have no rotation procedure here: the flag key is per-instance versioned in the architecture (04 section 11.2) but the port has no version argument yet (handoff H-137).

## Shredding and the backups (architecture 04 section 5.3)
The data database and the keystore are backed up under different rules, or shredding means nothing:
- The nightly dump of `vulnmart` (`scripts/backup.mjs`, 14 days) contains ciphertext and **never** the keystore. Do not add `vm_keystore` to it.
- The keystore is copied by `pg_dump -Fc vm_keystore` to a file kept **latest only**. After every shred: take a new snapshot, then delete every older snapshot, in that order. `DbKeyPort` takes an `after_shred` callback for exactly this; today nothing is registered, so the snapshot is a manual step or a story of the deployment tasks (P-32, L-17).
- A restore drill (spike S-19, LIVE): restore a data dump that is ten days old and the **latest** keystore snapshot. Attempts shredded since must be unreadable (`KeyShredded`); others must read. The same rule is proved in a test with a copy of the data taken before a shred (`test_crypto_shredding_survives_a_restore_of_the_data_spike_s10`); that is not a restore from backup files.
- A damaged keystore means unreadable data: keep the two latest snapshots in different places.

## The audit anchor (OI-28: self-hosted)
`app.state.audit_anchors.anchor()` verifies the whole chain and writes one signed line per day, `date seq head-hash signature`, to `audit_anchor` and, if `VULNMART_AUDIT_ANCHOR_FILE` is set, appends it to that file (flushed to disk). It refuses to anchor a chain that does not verify. The scheduler job that calls it daily is story P-24; until then run it by hand:
```
docker exec vulnmart-api python -c "from vulnmart.main import app; r = app.state.audit_anchors.anchor(); print(r.anchor_date, r.head_seq, r.created, r.witness)"
```
- Set `VULNMART_AUDIT_ANCHOR_FILE` to a path on a volume the service user can write (the container's root file system is read-only: mount a volume), then copy the file off VM-P regularly (backup bucket, a second machine). A line kept only on the same machine as the database proves little.
- The signature is a keyed hash under a key derived from the field secret; it detects a forged or edited line, not a thief who has the field secret and the file.
- To check: `app.state.audit_anchors.check(open(path).read().splitlines())` returns the problems (empty list means every line is genuine and agrees with the chain; a line older than the 12-month purge is skipped).

## What this does not do
- It does not take the keystore snapshot, ship the anchor file, or schedule the daily job (P-24, P-32, L-17).
- The signed one-line commit to a separate repository and the email to admins proposed in ADR 0008 are not built; the file and the database row are.
- The 12-month purge of old audit rows needs a privileged path that writes a checkpoint first (story P-24); the verification already starts from a checkpoint.
