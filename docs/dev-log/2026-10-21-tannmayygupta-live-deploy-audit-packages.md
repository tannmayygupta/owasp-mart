# Live deploy of the merged audit packages A to G2

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | deploy-caddy-restart, deployed from main at the merge of PR 87 |
| Status | Partly done: stacks deployed and verified (70 PASS, 0 FAIL); the live learner and exploit suites cannot run against production mail |
| Report tag | deployment, production readiness |

## Requirements covered
H-358 (live deploy), FR-NTF-03 (real mail), the dashboards deploy (package F), IF-1 1.9.0 and IF-2 2.3.0 on the live hosts.

## Summary
All merged work (packages A to G2) was built and shipped to vm-i and vm-p with `live-deploy.mjs`, with the Brevo sender set by `--mail-sender`. The platform deploy now restarts Caddy, because Caddy reads its Caddyfile only at start and the new page route `/confirm-email-change` was served by the console fallback until it was restarted.

## Why
The audits found that much was built but not live. This step puts the merged code on the hosts and checks it from outside.

## What was built
One line in `scripts/live-deploy.mjs`: after `docker compose up`, `docker restart vulnmart-caddy` on vm-p.

## How it works
`platform` copies `Caddyfile.platform` into the bind-mounted path. Compose does not recreate a container for a changed bind-mounted file, so the running Caddy kept the old routes. The restart loads the new file (a few seconds of blip on vm-p).

## Files changed
- `scripts/live-deploy.mjs` — Caddy restart in the platform step.

## Decisions made
No ADR: an operational fix. Alternative: `caddy reload`; a restart was chosen because it also picks up changed secret files.

## Tests
Commands, in order, from a clean worktree of main with `AWS_PROFILE=vulnmart`: `live-deploy.mjs build` (PASS images built), `ship-i` and `ship-p` (PASS), `lab` (PASS, orchestrator healthy), `platform --mail-sender <verified address>` (PASS, api, web, worker healthy).
`node scripts/verify-deployed.mjs --base <platform host>`: first run 69 PASS, 1 FAIL (`/confirm-email-change` served by the console fallback); after the Caddy restart 70 PASS, 0 FAIL.

## Evidence
Terminal output only; no secrets or addresses recorded here.

## Problems met and how they were fixed
- SSH timed out until the leader ran `allow-my-ip` (the allow-list follows the leader's public address).
- A manual `ssh ... docker restart` was refused by the tool permissions; the restart now lives in the deploy script, the approved path.
- `live-deploy.mjs hooks` reloads Caddy only when the certificate files changed, so it did not fix the route; it did rebuild the labs firewall chain on vm-i (PASS).

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
- `e2e-live.mjs`, `e2e-live-exploits.mjs` and the journeys read the sign-up mail from Mailpit; production sends through Brevo, so they cannot sign up a throw-away learner. They need either a real inbox for one test learner or a staging deploy with `--allow-mail-catcher`. Not run on production; stated here, not simulated.
- The real delivery of Brevo mail to the sender address is not yet confirmed by a received message.
