# Audit of the Lab stream (Tanmay, L-01 to L-31), 2026-10-18

Method. Six independent read-only reviewers each took a group of tasks and checked the "Done when" of every task against the code, the tests, the CI configuration and the committed evidence, not against the ticks. I added my own checks of the live system (certificates, host health, renewal journal, CI of `main`). Local suites were run by me earlier the same day: apps/api 2292 passed (4 skipped, Postgres enabled), orchestrator 467, py-attempts 357, `npm test` 1030 (2 skipped); CI of `main` is green.

Rule for the ticks in `docs/dev/dev1-tanmay.md` after this audit: **a box is ticked only when the "Done when" is demonstrably met on our side**. A task that is finished on our side but waits for another developer or a human live step stays unticked and says exactly what it waits on. Each task carries one "Audit 2026-10-18" line.

Result: **10 of 31 are verified complete (L-01, 02, 03, 04, 06, 07, 13, 16, 17, 20). 7 wait on another developer (L-05, 09, 11, 18, 26, 28, 30). 14 are open on our side or need a live step of the developer.** The platform runs end to end for a learner; it is not finished as a product.

## What the live system proves, and what it does not

Proves (deployed on AWS Sydney, `e2e-run8-merged-main.json`, 29 checks): sign-up and mail, instance start (about 6 s), one-time ticket and gate, planted flag credited, hints, reset with new flags, submit and freeze, report. Postgres persistence and restart, the key service in a separate keystore database, backup and restore on the deployed database (manual), a host audit (9 PASS).

Does not prove: the vulnerable **shop** (the instance runs the stub shop; the real injector is stream T), an **assessment** attempt, a **recruiter** report (no route or screen in main), long attempts (see B1), the demo rehearsal, S-8 sandboxing, load beyond 6 learners.

## Blockers (fix before real users)

| # | Where | Problem | Failure |
|---|---|---|---|
| B1 | orchestrator `engine.py:562`, `service.py:73` | Idle teardown cannot work in the real service: no signed route records player activity, so `last_activity` stays empty and every instance is destroyed `idle_minutes` after it was ready, even while someone plays. | A 2-hour assessment is killed at the template's idle limit. Needs an IF-5 route and the platform forwarding activity (handoff H-122, Akshay). Mitigation until then: set the template idle limit to the maximum. |
| B2 | `infra/hosts/vulnmart-certs.service` (was) | The renewal hook restarted a container that does not exist (`vulnmart-origin-caddy-1`); Caddy reads certificates only at start. | The renewed certificate would never be served; HTTPS fails on both hosts on 15 Jan 2027. **FIXED today**: `vulnmart-reload-caddy.sh` restarts the host's Caddy only when the certificate files changed (3-run test); installed on both hosts with `live-deploy.mjs hooks`. A forced real renewal is still to be done. |
| B3 | `terraform.tfvars`, `public_web_cidrs` unset | Ports 80 and 443 are open only to the developer's own IP. Your ISP address changed three times today and each time the hosts "went down". | Nobody else (examiners, Vercel) can reach the demo; the single-IP list also locks the developer out. Needs a decision: open 80/443 to the world on purpose (the design says "only 80 and 443 public") and use SSM instead of an open SSH port. |
| B4 | host chain `vulnmart-egress.sh:60,64` | The labs chain ACCEPTS tcp/443 to anywhere and tcp/9444 to the platform subnet before its final DROP; the ACCEPT in DOCKER-USER skips Docker's own isolation rules. Nothing probes instance-to-instance tcp/443. | The "an instance can reach nothing" claim rests only on Docker internal networks having no route. Isolation has been probed live only from a probe-made network, never from an orchestrator-made instance. |
| B5 | `ingest/engine.py`, runtime | The milestone engine ignores the attempt state and deadline: events after expiry or submit still credit milestones and change the score. C09 M2 is lost if the process restarts inside its 30 s grace. | A late or replayed event changes a frozen score. |
| B6 | runtime `build_lab_runtime` | No activity gate in production (`AllowAllGate`): nothing is ever held for review; the integrity signals (`integrity.py`) are library code never imported by the API. | L-27 anti-cheat does not run. |

## Major

- Scoring ignores mode: learners are charged hint costs the UI shows as 0 (`api.py:306` vs `RuntimeFacts`). Template rules (time limit, resets, hint mode) never reach the lab: every candidate gets 120 min, 3 resets, hints off. (L-22/L-23; cross-stream with Akshay.)
- No off-host backup, no schedule, and the keystore (all wrapped keys) is not backed up by design: losing vm-p loses every key. Restore was proved on the deployed database today but by hand.
- No monitoring, alerting or log shipping anywhere (budget e-mail only, unconfirmed). SSM agents run on both hosts but no instance profile is attached, so SSM cannot be used yet.
- Detection is a hint, not a classifier: S-6 sees 15 of 16 request-visible exploits (SQLi, XSS, SSRF only); the 8 logic-bug challenges depend entirely on shop app events (Sahil). Forgery risk: any process that can reach the sidecar can post `shop.*` events for its own instance.
- Old-epoch events are accepted as "late history"; confirm the engine cannot credit them (check with B5).
- Reset does not bump the access epoch (old cookies survive a reset); an adopted instance cannot be reset after an orchestrator restart.
- Quotas are in the platform, not the orchestrator; the capacity figure (about 7 instances) uses a demo template of 192 MB for the shop and counts container limits only.
- No branch protection on `main` (gh: 404): CODEOWNERS and the contract approvals are advisory. `COMPAT.md` is stale (IF-2 1.0.1 and DB 2.0.0 exist, COMPAT says 1.0.0; Sahil's and Akshay's earlier sign-offs do not cover DB 2.0.0).
- Milestone rule deviations from the challenge specs: C01 M2 alternative, C03 (one key where the spec has two flags), C07 M1, C08 M2 pairing. FR-TIM-04 events on the allow-list are never emitted; `time_metrics` raises (500) if a capture precedes the start.
- No image or dependency scanning in CI (no SBOM, no Trivy or audit step, no Dependabot). The CI scan for flag patterns (L-19) is a script, not a CI job.
- Retention: no scheduler (P-24) and no deletion workflow (P-25), so the consent notice's "deleted after N days" is not enforced; erasure on withdrawal now works (key shred, purge, retry) but a platform deletion through the port does not shred.

## Minor (collected)

Gate: used one-time ticket ids are in memory (replay window 60 s after an edge restart); no WebSocket support; client `x-forwarded-*` headers are forwarded. Relay listens on 0.0.0.0 inside the edge container. Sidecar has no concurrency cap on 8080. `checker.py` cost grows with instances (paste endpoint needs a rate limit). Orchestrator: nonce memory per process; host reboot sweeps all instances (restart=no, undocumented); no image GC or disk-full handling; the tombstone file grows without bound. Review decisions use a process-local lock. `store.due` scans every non-terminal attempt every 10 s. The cloud-init user data is pinned (`ignore_changes`), so host fixes need `live-deploy`. The labs host may reach any HTTPS address (egress). `LEGO_EXTRA_ARGS=--dns.propagation.disable-ans` workaround lives outside the repo. Terraform state is one local file on one PC.

## Per task

| Task | Verdict | Evidence and gap |
|---|---|---|
| L-01 | VERIFIED | pins, `dev.mjs hello`, CI green on PRs. No branch protection. |
| L-02 | VERIFIED | IF-6 validates (7 valid, 192 invalid); Sahil approved at 1.0.0 in COMPAT. Owner rows pending (L-09). |
| L-03 | VERIFIED | 29 events valid, 69 invalid refused, fake ingest 44 of 44. |
| L-04 | VERIFIED with caveat | fake host passes the protocol tests; the client is hand-written, not generated; drift is caught only by `check_orchestrator_contract.py`. |
| L-05 | WAITING Akshay | IF-2 fragment, mock and checks exist; Akshay's consumer review is pending; ADR 0019 Proposed. |
| L-06 | VERIFIED | harness and conformance run in CI (`compose`, `e2e`), green. |
| L-07 | VERIFIED | checker with 84 tests, base-commit (trusted) and head runs green on GitHub; a breaking PR going red on GitHub was not recorded. |
| L-08 | OPEN, human | hosts and firewall real; budget e-mail unconfirmed, only one developer key, stop/start rehearsal not done, keep-alive off, Terraform state local, cloud-init error repaired by hand. |
| L-09 | WAITING Akshay, Sahil, Tanmay | no tag `contracts-v1.0.0`; 16 approval rows pending; COMPAT stale; no branch protection. |
| L-10 | OPEN | real certificates, one real renewal on vm-p; the reload hook was broken (fixed today, B2); the vm-i wildcard renewal was never exercised; no alert on a failed renewal. |
| L-11 | WAITING Akshay | only a throwaway Vercel probe; the real site (P-07) is not deployed; S-14 recorded. |
| L-12 | OPEN | `images.yml` builds and pushes amd64 only; no deploy pipeline; arm64 dropped by D-51. |
| L-13 | VERIFIED (stub image) | readiness only after injection; S-4 n=10, median 2.1 s, p95 2.8 s on the 30 MiB stub; real shop images unmeasured (Sahil T-04). |
| L-14 | OPEN | B1; reconciler uses an all-wanted desired state (H-123, Akshay); no live kill test. |
| L-15 | OPEN | B4; live probe only from a probe-made network. |
| L-16 | VERIFIED (stub) | 20 of 20 ready in 16.1 s live; build cap and retry; quotas enforced at the platform against the fake port. Numbers are stub numbers. |
| L-17 | VERIFIED | gate tests 96 of 96; live: wildcard certificate, ticket once only, forged ticket refused, no instance port published (audit). Not run live: a second account against another's instance. |
| L-18 | WAITING Akshay | event relay and replay checks verified; the platform half of FR-SES-11 (login bumps the access epoch, H-341) is absent. |
| L-19 | OPEN | flags derived, reset invalidates (live), key service is real; the CI flag scan is a script, not a CI job; decoy placement waits on Sahil's catalogue (H-331). |
| L-20 | VERIFIED (limits stated) | automatic capture credited live; S-6 measured; detection is hint-level (see Major). |
| L-21 | OPEN | rules for all 11 challenges exist and fire in tests; spec deviations, C09 M2 lost on restart (B5), FR-TIM-04 events not emitted. |
| L-22 | OPEN | engine verified; B5; template rules not passed (Akshay + us); scheduler scans all rows. |
| L-23 | OPEN | reproduces all six Appendix A examples; learner hint-cost defect. |
| L-24 | OPEN | restore proved locally and (by hand) on the deployed database; no schedule, no off-host copy, keystore not covered. |
| L-25 | OPEN | metrics and ids-only log verified; allow-listed events never emitted; `time_metrics` can 500. |
| L-26 | WAITING Akshay | reset limit, withdrawal, undo and erase verified (shred and retry proved on Postgres); no HTTP withdraw, cancel or undo route (platform API, H-346). |
| L-27 | OPEN | B6. |
| L-28 | WAITING Akshay | library only; no port and no route; waits on the recruiter dashboard (P-27) and a small `EngineCohortPort` on our side. |
| L-29 | OPEN | B4; S-8 skipped by the developer; S-15 emulated; address pools not raised. |
| L-30 | WAITING Akshay (P-32), Sahil (T-32) | learner journey 29 of 29 on the stub shop only; no assessment, invite or recruiter report; real shop not wired. |
| L-31 | OPEN, human | rehearsal never run; the pack checker only counts files. |

## What other developers must deliver for a real end-to-end demo

Akshay: routes and screens for create-assessment, send-invite, accept-invite and consent (P-22); recruiter dashboard and report access (P-27); candidate dashboards (P-26); activity forwarding to the orchestrator (H-122) and the desired-state list (H-123); template rules and hint mode passed into the attempt; login bumps the access epoch (H-341); withdraw, cancel, undo and cohort routes (H-346); retention and deletion workflows (P-24, P-25); contract sign-offs (P-08); P-32.
Sahil: the real shop images with the injector wired to the orchestrator; challenges C07 to C11 (T-25 to T-29) and their app events; catalogue content and decoy placement (T-30, H-331); cross-challenge tests (T-31); T-32.
Tanmay after those: extend `e2e-live` with an assessment and a recruiter report, re-measure load with the real shop, rehearse twice.

## Fix plan, in order

1. B2 renewal hook: done, deployed. Next: force one real staging renewal on vm-i to prove it.
2. B1: add the signed activity route to IF-5 and have the runtime forward activity (throttled); until then set the demo template's idle limit to the maximum.
3. B3: decide the access model (public 80/443; SSM instead of SSH from a changing address; needs an IAM instance profile).
4. B5, B6, scoring mode and template rules, L-25 fixes, L-19 CI scan job.
5. B4: close tcp/443 and 9444 for peer subnets in the labs chain and probe from an orchestrator-made instance.
6. Backups off host on a timer, keystore decision, monitoring and alerts.
