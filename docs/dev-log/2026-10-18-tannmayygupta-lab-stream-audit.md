# Audit of the Lab stream (L-01 to L-31) and honest task statuses

Developer: tannmayygupta. Date: 2026-10-18. Branch: audit-l-tasks.

## Requirements covered
All lab-stream requirements as listed per task in docs/dev/dev1-tanmay.md; production-readiness epic story 6 (the readiness report).

## Summary (plain language, 3-5 lines)
Six independent reviewers checked every task against the code, tests, CI and evidence instead of the ticks, and I checked the live system. Ten tasks are verified complete and ticked. Seven wait on Akshay, Sahil or both. Fourteen are open on our side or need a human live step. The audit also found six blockers; one (the certificate renewal hook that would have broken HTTPS on 15 January 2027) is fixed and deployed.

## Why
The earlier ticks were made on the developer's instruction or after local proof only. The request was an honest, evidence-based status with nothing marked complete that is not.

## What was built
- docs/audit/2026-10-18-lab-stream-audit.md: the full audit (blockers, majors, minors, per-task verdicts, what each other developer must deliver, a fix plan in order).
- docs/dev/dev1-tanmay.md: ticks reduced to the 10 verified tasks, one "Audit 2026-10-18" line on each of the 31 tasks.
- Fix B2: infra/hosts/vulnmart-reload-caddy.sh (restart this host's Caddy only when the certificate files changed), vulnmart-certs.service calls it, cloud-init and Terraform locals carry it, `node scripts/live-deploy.mjs hooks` installed it on vm-p and vm-i.

## How it works
The renewal timer runs lego twice a day; after each run the unit calls the script, which hashes the files of the folder Caddy serves, compares with the last hash, and restarts the Caddy container (vulnmart-caddy on vm-p, vulnmart-edge-caddy on vm-i) only when they differ. The first run only records the state.

## Files changed
docs/audit/*, docs/dev/dev1-tanmay.md, infra/hosts/{vulnmart-reload-caddy.sh, vulnmart-certs.service, cloud-init.yaml.tftpl}, infra/terraform/aws/compute.tf, scripts/live-deploy.mjs (+test), scripts/reload-caddy-hook.test.mjs.

## Decisions made
No technical decision that needs an ADR. The rule for the ticks is written at the top of the audit.

## Tests
- scripts/reload-caddy-hook.test.mjs and scripts/live-deploy.test.mjs: 7 passed (the script is run three times against a stub docker: first run records, unchanged restarts nothing, a changed file restarts the running Caddy once, the same change is not applied twice).
- terraform validate: success; terraform fmt applied to compute.tf.
- Live: `live-deploy.mjs hooks` ran on both hosts; both printed "first run, state recorded" and the installed unit shows ExecStartPost=-/usr/local/sbin/vulnmart-reload-caddy.sh. The journal of vm-p before the fix showed "No such container: vulnmart-origin-caddy-1" on every run.
- Live facts I checked myself: both certificates are Let's Encrypt and expire 15 January 2027; vm-p disk 27 percent, memory 892 of 1905 MB; vm-i disk 18 percent, memory 1138 of 7776 MB; no container restarting; the SSM agent runs on both hosts but no instance profile is attached.

## Evidence
docs/assets/production-readiness/ (journey and load runs of the same day).

## Problems met and how they were fixed
The first version of my live check printed nothing useful because PowerShell mangled quoting in remote commands; scripts are now copied and run as files.

## Limitations and follow-ups
Everything in the audit fix plan except B2 is open. The audit is a read of the code by reviewers plus my checks; it did not run the Docker-based suites (they were run by me earlier) and it did not re-run S-6.