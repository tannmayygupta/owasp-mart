# Runbook: create the first admin (seed command)

Admins are never created by signup (FR-ACC-11). The first one is made by an operator on the server; after that an admin can create more (an admin screen for that is story P-28).

## Local stack (Docker Compose)
Start the platform (`node scripts/dev.mjs up platform web`), then run inside the API container:

```
docker exec -e VULNMART_SEED_ADMIN_PASSWORD='<at least 16 characters>' vulnmart-api python -m vulnmart.accounts.seed_admin --email you@example.org --name "Your Name"
```

- The password is never put on the command line. It comes from `VULNMART_SEED_ADMIN_PASSWORD`, or from one line on standard input with `--password-stdin`, or (neither given) the command makes a random 24-character one and prints it once.
- Exit code 0: created. 2: a value is not acceptable (address, name, or a password outside 16 to 128 characters). 3: an account with that address exists already, nothing changed. 1: no database address.
- The account exists at once, with the address already marked verified, and holds no learner or candidate role. **It cannot sign in until the second factor exists (story P-15)**: a login answers a generic error and the log says why.
- The audit entry `admin.created` (actor `system:seed`) is written to the in-memory audit port and also to the log as a warning line. The durable audit log is story P-17, so until then keep the log line if you need the trace.

## Staging and production
Same command, run on VM-P in the API container with its own environment (`VULNMART_POSTGRES_DSN` from the secret files). Do not leave the password in shell history: use `--password-stdin` and pipe it from a password manager, or let the command generate one. Change it at the first sign-in once the password-reset story (P-14) is in.

## Another admin from an admin
`AdminService.create_admin` (an active admin only) makes the account with a random password nobody knows and mails the new admin a single-use link to choose their own (template `account.admin_created`, a `reset` token, consumed by story P-14). There is no route for it yet (story P-28).
