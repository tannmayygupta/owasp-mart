# Runbook: live demo of 19 Oct 2026 (story 8.6, L-30 live part)

Goal: a demo that survives a bad network, a dead VM or a mistake. You run every step; I (Claude) cannot reach the VMs, AWS or the deployed site. **No rehearsal result exists until you record it in the two tables at the end.**

Placeholders: `<site>` is the deployed dashboards origin, `<vm-p>`, `<vm-i>` are the host names you already use. Do not paste addresses, account ids, tokens or flags into notes you commit.

## Timeline

| When | What | Where |
|---|---|---|
| T-24 h (18 Oct, morning) | Freeze: only fixes for demo blockers from now on. Confirm the commit you will demo (`git rev-parse --short HEAD`) and write it down. Make the backup (`backup-restore.md` B and C). Start `vm-i` if it is stopped (`aws-account-and-vms.md`, "What a stop of `vm-i` does"). | PC, vm-p, vm-i |
| T-20 h | Rehearsal pass 1, full script below, on the deployed site. Record it. Fix what failed. | deployed site |
| T-16 h | VM-I audit: `vmi-hardening.md` Part A. Fix a FAIL with an existing control only (D-99). | vm-i |
| T-12 h (evening) | Rehearsal pass 2 after the fixes. Record it. Run `node scripts/fallback.mjs up`, `check`, `down` once on the demo laptop (`laptop-fallback.md`). Charge the laptop, put the charger in the bag. | deployed site, laptop |
| T-2 h (19 Oct) | Pre-flight checklist below. Close other programs. Disable laptop sleep. | all |
| T-30 min | Pre-flight again (short form: items 1, 2, 3, 8). Open the browser tabs. Docker Desktop running with the fallback images already built. | all |
| T-0 | Demo. | |
| After | Stop `vm-i` (`isolation-vm-i.md` step 12 pattern: `vm_i_running = false`, `terraform apply`) to save credits. | AWS window |

## Pre-flight checklist (run in this order; every line has an expected result)

AWS window first line: `$env:AWS_PROFILE = "vulnmart"` (new window, new profile line).

1. Demo commit is checked out and clean: `git status --short` prints nothing; `git rev-parse --short HEAD` equals the one you wrote down.
2. Deployed site answers, with the right headers (read-only GET checks):
   ```powershell
   $env:SMOKE_BASE_URL = "https://<site>"
   $env:SMOKE_VERSION_PATH = "/api/v1/version"      # only if that route exists on the deployed API; otherwise leave it out
   node scripts/live-smoke.mjs
   ```
   Expected: every line PASS and `live-smoke: PASS`. A FAIL names the URL and the header or status. If the site lacks `x-content-type-options: nosniff`, that is a finding about the Vercel header config, not about this script: fix the config or tell me; do not edit the script's rule on demo day.
3. VM-I state saved today: `vmi-hardening.md` Part A steps 2 to 4, all PASS (or the FAIL is understood and fixed).
4. Isolation probe still passes on vm-i: `isolation-vm-i.md` step 3 only (host rule ON). Last line `isolation probe: PASS (...)`.
5. A fresh encrypted backup exists and `verify` passes (`backup-restore.md` B and C).
6. Laptop fallback images are built: `node scripts/fallback.mjs up --no-web`, `node scripts/fallback.mjs check` (all PASS), `node scripts/fallback.mjs down` (`PASS down`). Ports 3000, 8000, 8025 free afterwards.
7. Local suite on the laptop, quick: `node --test scripts/vmi-audit.test.mjs scripts/live-smoke.test.mjs scripts/backup.test.mjs scripts/fallback.test.mjs scripts/check-submission-pack.test.mjs` all pass. (The full CI is the pull request's job; do not start long suites on demo morning.)
8. Both hosts are up and the labs host is running: check in the AWS console or with `aws ec2 describe-instances --query "Reservations[].Instances[].[Tags[?Key=='Name']|[0].Value,State.Name]" --output text`. Expected: `vm-p running`, `vm-i running`.
9. Screen: 1920x1080 or the projector's size, browser zoom 100 %, notifications off, one browser window with the tabs in the order of the script, terminal font large.
10. Notes: this runbook open on a second screen or printed; the failure table within reach.

## The demo script (about 12 minutes, with the talk track)

Say the one-sentence version first: "VulnMart is a vulnerable web shop for security training. Every player gets a private instance, and the platform scores what they find."

1. **The platform (2 min).** Open `https://<site>`. Say: dashboards on the Vercel site, API on our host behind a gate that only accepts calls with a secret header the browser never sees. Show the health page or `/api/v1/health` through the site. If asked, show the 403 when the secret is missing (`curl -s -o NUL -w "%{http_code}" https://<platform host>/api/v1/health` prints 403; that is the gate working).
2. **A player starts an attempt (3 min).** Sign in as the demo player, open the challenge list, start the challenge you rehearsed. Say: the orchestrator builds a private instance: a volume keeper, an injector that plants this player's flag, then the shop; the instance is `ready` only after the injector finished and the shop is healthy. Show the attempt clock starting at ready and the deadline from the server (the browser never computes time).
3. **The attack and the score (3 min).** In the instance, do the exploit you rehearsed (the one with the shortest path). Show the milestone appearing on the dashboard (events come from the sidecar, signed, over the ingest). Paste the flag; show the score change. Say: flags are per player and per instance, recomputed on submit, nothing is stored in plain text.
4. **Isolation (2 min).** Show `docs/assets/story-8-5-vmi-audit/` (the audit table) and the probe's last line. Say: an instance can reach only its own sidecar; the host rule drops the rest; the Docker socket sits behind a read-only proxy; the audit is read-only. Be precise: "checked, not extended" for user namespaces, rootless Docker and gVisor (spike S-8 is open).
5. **Safety and recovery (1 min).** Say: the attempt expires on the server clock, access freezes, the instance is destroyed, and the database is backed up encrypted with a tested restore (show one `restore-test` output, 6 PASS lines). Mention the laptop fallback exists.
6. **Close (1 min).** "Everything you saw is traced from requirement to test in the traceability matrix, with the evidence in the repository."

Keep a rehearsed answer for the three likely questions: why a vulnerable app on the internet (isolation plus per-player instances), what happens if a player escapes (host rule, no socket, audit, destroy), what is not done (S-8 extra isolation, live S3 backup if you did not run it, anything on the deferred list).

## Failure table

| Symptom | Likely cause | First action (under 2 min) | If it is not fixed in 5 min |
|---|---|---|---|
| Site does not load | Vercel or DNS | Reload once; open the Vercel status page on your phone | Switch to the laptop fallback |
| Site loads, API calls 403 or 502 | Origin secret differs from the host file, or vm-p Caddy down | `vercel-and-origin.md` Part E: `curl -s <site>/api/v1/echo` (shows `secretPresent`); on vm-p `docker ps` shows Caddy up | Switch to the fallback |
| API 5xx | API container down or database not ready | On vm-p: `docker ps`, `docker logs --tail 50 vulnmart-api` | Switch to the fallback |
| Attempt stuck at "starting" | vm-i stopped, orchestrator down or the image pull is slow | Check vm-i is running (pre-flight 8); on vm-i `docker ps` shows the proxy and orchestrator | Switch to the fallback (`node scripts/dev.mjs demo --keep` for a local instance) |
| Instance never ready | Injector or shop unhealthy | Look at the state report in the dashboard (the failing component is named); one retry | Show the local demo instead |
| Flag not credited | Player on the wrong instance, flag from an old instance (stale epoch) | Start a new attempt and use its flag | Show the credited milestone from rehearsal evidence and move on |
| Score does not change | Event path (sidecar to ingest) down | Say so, show the milestone log; do not debug live | Fallback or evidence |
| Network down at the venue | Wi-Fi | Phone hotspot (rehearse it once) | Switch to the fallback: nothing after that needs the internet |
| Laptop dies | Hardware | Second device with the repository and images is NOT planned; say so now if you want one | Show the evidence in `docs/assets` and the runbooks |
| Audit or probe shows FAIL right before | Rule or config drift | `vmi-hardening.md` "If a line is FAIL" (existing controls only) | Tell the audience what is checked, show the last good run's date |

## The fallback switch (decide out loud, once)

1. Say: "I am switching to the local copy." Do not debug in front of the audience.
2. In a terminal already open in the repository: `node scripts/fallback.mjs up` then `node scripts/fallback.mjs check` (all PASS, about 3 minutes with warm images). For a live instance use `node scripts/dev.mjs demo --keep` (stop the fallback first; fixed container names).
3. Open http://127.0.0.1:3000 and continue the script from the step where it failed. What works and what does not: `laptop-fallback.md`.
4. After the demo: `node scripts/fallback.mjs down` and, if used, `node scripts/dev.mjs demo down`.

## Rehearsal records (fill in yourself; the status stays "not run" until you do)

**Pass 1 (target T-20 h)**

| Field | Value |
|---|---|
| Date and time | not run |
| Commit | |
| Pre-flight items that failed | |
| Script steps that failed or were slow (minutes per step) | |
| Total time | |
| Fixes made (and the commit) | |
| Failure table row you had to use | |

**Pass 2 (target T-12 h)**

| Field | Value |
|---|---|
| Date and time | not run |
| Commit | |
| Pre-flight items that failed | |
| Script steps that failed or were slow (minutes per step) | |
| Total time | |
| Fallback switch tried (up, check, down), time taken | |
| Anything still open | |

Tell me both tables and I put the real results in the dev-log, the traceability rows (LX-1, LX-3, LX-4) and the report notes. I will not write them before.
