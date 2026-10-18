# Production readiness 9.4 and 9.5: real instances on vm-i and the deployed system, verified

Developer: tannmayygupta. Date: 2026-10-18. Branch: sprint-4-tanmay. Stories: epic-production-readiness 4 (in progress) and 5 (verification done, one run open).

## Requirements covered
FR-INS-01, FR-INS-02, NFR-ISO-01, NFR-ISO-05, LX-1, LX-2 (see docs/traceability.md rows LE-12, LE-13).

## Summary (plain language, 3-5 lines)
Both hosts now run the whole system: vm-p has the platform (database, API with the lab runtime, worker, Caddy, console) and vm-i has the instance host (Docker proxy, edge, orchestrator, local registry). A learner can sign up, confirm by mail, start an instance, read a flag and submit it on the real domains. The one part that is not real: the shop in an instance is the stub shop with planted flags, because the real shop has no injector yet (stream T).

## Why
The earlier work was proved only with fakes and local tests. The request was to prove it on the real machines, with the real database, keys, certificates and orchestrator.

## What was built
- Deployment files: infra/deploy (platform compose, Caddyfile, app role SQL), scripts/deploy-secrets.mjs (private CA and keys outside the repository), scripts/live-deploy.mjs (build, ship, lab, platform, status, down), docs/runbooks/live-deploy.md.
- Lab console (apps/lab-console) served from vm-p; edge relay over TLS with a CA file; orchestrator capacity from the environment.
- Fixes found only by deploying: the API now hex-decodes the gate key like the edge does (tickets were refused), and a full instance host answers 429 instead of an internal error.
- Audit: the two Caddy containers may add NET_BIND_SERVICE (documented), nothing else may; tests added.

## How it works
Start request goes through Caddy to the API, the API asks the orchestrator over mTLS (private network), the orchestrator creates the containers from digest-pinned images in the local registry, the edge gate checks a signed ticket, the sidecar reports events back over the private TLS listener.

## Files changed
infra/deploy/*, infra/compose/compose.yaml, apps/lab-console/*, apps/edge/src/{relay,server}.mjs, apps/api/src/vulnmart/lab/{api,tickets}.py, scripts/{deploy-secrets,live-deploy,e2e-live,vmi-audit}.mjs and their tests, docs/runbooks/live-deploy.md, docs/assets/production-readiness/.

## Decisions made
None new that needed an ADR; the private CA over the private link and the local registry follow the existing deployment decisions.

## Tests
- Deployed end-to-end (scripts/e2e-live.mjs, three runs, 29 of 29 checks each): docs/assets/production-readiness/e2e-run1..3.json.
- Load: 4 learners and 6 learners, all instances ready; for 6: first 7.9 s, median 12 s, slowest 17.5 s (load-6.json). Beyond the capacity budget the API answers 429 (load-capacity-limit.json).
- Audit on the saved vm-i outputs, 47 containers including 7 instances: 9 PASS, 0 FAIL, 0 SKIP (vmi-audit-result.txt). IMDS: both instances require tokens, hop limit 1 (read-only aws describe-instances).
- Backup and restore on vm-p (manual equivalent of scripts/backup.mjs, because the script needs docker access without sudo on the host): pg_dump, AES-256-CBC with pbkdf2 600000, checksum verified, decrypt round trip equal, restored into a scratch database, all 27 tables with equal row counts, scratch database dropped, files removed.
- Persistence: API container restarted; attempts 16, deks 16, instances 12, flag submissions 10, users 16, sessions 16 before and after.
- Local suites: apps/api 1766 passed, 4 skipped (Valkey not set); apps/orchestrator 467 passed; packages/py-attempts 357 passed; `npm test` 1030 passed, 2 skipped, 0 failed (one earlier full run showed the TypeScript client test failing once, a rerun alone and a full rerun passed; cause not found, probably load).

## Evidence
docs/assets/production-readiness/ (no secrets; addresses and instance ids redacted in the audit inputs).

## Problems met and how they were fixed
GNU tar on Windows reading "C:" as a host; /opt/vulnmart mode; an old throwaway Caddy holding 443; Caddy not able to read files owned by 65532; relay URL needing the full path; orchestrator needing a restart after a manifest change; gate key text versus hex bytes (ticket 403); the capacity error becoming a 500. All fixed and recorded in the runbook.
A fourth journey after the API restart (e2e-run4-after-restart.json) FAILED at "request an instance" with HTTP 429: seven instances from earlier runs still hold the orchestrator budget. Removing them on vm-i was denied by the permission classifier (deletion scope), so it was not done. This is the open item.

## Security notes (vulnerable parts only)
No flag or secret is in any doc. The origin secret and key files are outside the repository.

## Limitations and follow-ups
- No real exploitable shop instance until stream T delivers the injector (T-17 to T-32).
- Story 4 stays in progress for that reason; story 5 waits for the developer to confirm.
- Candidate and recruiter flows need stream P (consent, invites, company scope, live view).
- S-8 (runtime sandboxing) not tested live. Accepted findings B9, C3, C4, C5, C8, D11 remain as written in the review-findings dev-log.
- CI has no Postgres service, so the database tests run only locally.
- vm-i and vm-p are running and cost money until stopped.