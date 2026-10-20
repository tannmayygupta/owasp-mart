# Runbook: create the first admin (seed command)

Admins are never created by signup (FR-ACC-11). The first one is made by an operator on the server; after that an admin can create more (an admin screen for that is story P-28).

## Local stack (Docker Compose)
Start the platform (`node scripts/dev.mjs up platform web`), then run inside the API container:

```
docker exec -e VULNMART_SEED_ADMIN_PASSWORD='<at least 16 characters>' vulnmart-api python -m vulnmart.accounts.seed_admin --email you@example.org --name "Your Name"
```

- The password is never put on the command line. It comes from `VULNMART_SEED_ADMIN_PASSWORD`, or from one line on standard input with `--password-stdin`, or (neither given) the command makes a random 24-character one and prints it once.
- Exit code 0: created. 2: a value is not acceptable (address, name, or a password outside 16 to 128 characters). 3: an account with that address exists already, nothing changed. 1: no database address.
- The account exists at once, with the address already marked verified, and holds no learner or candidate role. **It signs in with the password, but a session without a proved second factor holds no admin role**, so nothing admin-only works until an authenticator app is set up (see "First sign-in" below).
- The audit entry `admin.created` (actor `system:seed`) is written to the durable audit log in the same database, pseudonymised like every other entry (story P-17; the command used an in-memory stand-in until story 1.9).

## First sign-in: set up the authenticator app (FR-ACC-07)
Every admin needs a second factor. There is no admin page yet (dashboards), so through the API, with the browser's own cookie and the CSRF token of the session:
1. `POST /api/v1/session` with the email and password. The answer is a session (`mfa_enabled` is false); the cookie works but carries no admin role.
2. `POST /api/v1/me/mfa` (header `X-CSRF-Token`) returns an `otpauth://` address. Put it in an authenticator app (for example as a QR code made from the address, or type the `secret` by hand). **Treat the address as a secret: it is shown once.**
3. `POST /api/v1/me/mfa/confirm` with `{"code": "<the 6 digits the app shows>"}` turns the factor on and returns **ten recovery codes, shown only this once**: store them offline. The session cookie changes and now carries the admin role.
4. From then on a sign-in is two steps: `POST /api/v1/session` answers `mfa_required` with a ticket (valid 5 minutes, five tries), then `POST /api/v1/session/mfa` with the ticket and a code. A recovery code works in place of a code, once each.
5. An admin cannot turn the second factor off. If the phone is lost and the recovery codes are gone, an operator has to intervene in the database (there is no self-service path by design): see "Lost second factor" below.

## Lost second factor (an admin without phone and recovery codes)
Added in story 1.9 (deferred item F3). There is no route for this on purpose: removing an admin's second factor is an operator's step on the server.
1. **Check who is asking** outside the platform (in person or through a channel you already trust). A request by email alone is not enough: taking over an admin account is exactly what an attacker would ask for.
2. Find the account: `SELECT id, status FROM users WHERE email_ci = lower('<address>') AND account_type = 'admin';`
3. In one transaction, as the database owner role (the migration role, not the application role), remove the factor and end every session of that account:
   ```
   BEGIN;
   DELETE FROM recovery_codes WHERE user_id = '<id>';
   DELETE FROM mfa_credentials WHERE user_id = '<id>';
   UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL;
   COMMIT;
   ```
4. The admin signs in with the password (the session holds no admin role) and sets up a new authenticator at once (steps 2 and 3 above). If the password may be known to someone else, reset it first (`POST /api/v1/password-reset/request`).
5. The database change is not in the platform's audit log (no route made it). Write down who asked, who checked and who ran it, with the date, where the team keeps its operations record, and tell the other admins.

## Staging and production
Same command, run on VM-P in the API container with its own environment (`VULNMART_POSTGRES_DSN` from the secret files). Do not leave the password in shell history: use `--password-stdin` and pipe it from a password manager, or let the command generate one. Change it at the first sign-in (`POST /api/v1/me/password`). Set `VULNMART_FIELD_SECRET_FILE` (at least 32 bytes) on the API: it seals the second-factor secrets, and the API does not start in staging or production without it.

## Another admin from an admin
`AdminService.create_admin` (an active admin only) makes the account with a random password nobody knows and mails the new admin a single-use link to choose their own (template `account.admin_created`, a `reset` token, consumed by story P-14). There is no route for it yet (story P-28).
