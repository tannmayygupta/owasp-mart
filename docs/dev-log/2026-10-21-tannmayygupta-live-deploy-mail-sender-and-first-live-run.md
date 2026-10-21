# Live deploy of the merged audit work, the verified mail sender (live run)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `deploy-mail-sender` (commit hash after the commit) |
| Status | Done (in review); mail delivery waits for an external setting |
| Report tag | H-358, F-03, F-04, work package C |

## Requirements covered
H-358 (redeploy main and the dashboards), F-03 (real mail), F-04 (dashboards deployed). Story: `docs/bmad/initiative-lab/backlog/story-records-reconciliation-and-record-checks-plan.md` (tracker note).

## Summary (plain language, 3-5 lines)
Everything merged today (packages A, B, C, D, G) was deployed to both hosts: the lab stack on vm-i and the platform stack on vm-p, now with the dashboards container, the retention scheduler and real mail configured (Brevo). The sender address of the mails is now a deploy option (`--mail-sender`), because the verified Brevo sender is a personal address, not `no-reply@<platform host>`. The deployed verification went from 49 pass and 14 fail to 68 pass and 0 fail.

## Why
The first platform start failed: the API refused to start because the compose names Mailpit's host for its optional catcher profile (the runtime check refused any catcher host even when Brevo was the provider), and the sender was fixed to a domain nobody had verified.

## What was built
- `scripts/live-deploy.mjs`: `--mail-sender <address>` (default `no-reply@<platform host>`) written into the platform `.env`; `infra/deploy/platform.compose.yaml` reads it.
- `apps/api/src/vulnmart/notifications/config.py`: a catcher host is only a problem when SMTP is the provider; a bare sender variable in a compose file counts as supplied by the deployment. Test updated (`test_wp_b_mail_config.py`).

## How it works
`live-deploy.mjs platform --mail-sender <the verified address>` (the verified Brevo single sender, OI-32) stages the Brevo key file and writes the sender into the `.env`; the API and the worker validate it at start.

## Files changed
`scripts/live-deploy.mjs`, `infra/deploy/platform.compose.yaml`, `apps/api/src/vulnmart/notifications/config.py`, `apps/api/tests/test_wp_b_mail_config.py`, docs.

## Decisions made
The runtime mail check follows the provider, not the leftover SMTP host (the compose keeps the host for the optional catcher profile).

## Tests
- Local: `pytest apps/api/tests/test_wp_b_mail_config.py test_production_guards.py test_kernel_settings.py` 53 passed; `node --test scripts/live-deploy.test.mjs` passes; one deployed-compose lint test fails only on this Windows checkout (CRLF line endings in the Caddyfile; it passes in CI on Linux).
- Live: `node scripts/verify-deployed.mjs --base <platform host>`: 68 PASS, 0 FAIL (before: 49 PASS, 14 FAIL). `/login` answers 200 (the dashboards container). The retention scheduler runs (a `log_purge` job line in the API log).
- Live mail: a sign-up verification mail was queued and the worker answered `retry (provider-auth)`: Brevo answers 401 "unrecognised IP address" for the API key (checked directly: the same 401 from the developer's PC). The key is valid only from authorised addresses; see Limitations.

## Evidence
Command output above; the API and worker logs on vm-p.

## Problems met and how they were fixed
- The fresh worktree lacked the local Terraform state (`live-deploy.mjs` reads `terraform output`): copied the untracked state files into the worktree.
- SSH needed the deploy key in the agent (passphrase typed by the developer).
- The API refused to start (catcher host with Brevo): fixed as above, rebuilt, shipped, restarted.

## Security notes (vulnerable parts only)
None. The Brevo key is a file in the deploy secrets folder outside the repository; it was pasted into the conversation, so it should be rotated.

## Limitations and follow-ups
- Brevo: add the platform host's address (and any machine that sends) under "Authorised IPs" at app.brevo.com/security/authorised_ips, or switch the restriction off; queued mails then go out on the next retry (6 attempts with back-off). Verify that the sender address is a validated sender in Brevo.
- Rotate the Brevo key (it appeared in a chat).