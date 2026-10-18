# Audit fixes B3, B4 and B5 (public access, host firewall, late events and restarts) and a repeatable live audit

Developer: tannmayygupta. Date: 2026-10-19. Branch: fix-b1-b6-activity-and-gate (same pull request as B1 and B6).

## Requirements covered
NFR-ISO-01, NFR-ISO-05 (instance isolation), FR-DET-06 (C09 window), FR-SCR-01/FR-TIM (score only inside the attempt), R-4 (public lab); L-14, L-15, L-21, L-22; audit blockers B3, B4, B5.

## Summary (plain language, 3-5 lines)
B3: ports 80 and 443 are now open to everybody (the demo is reachable from any network); SSH stays limited to the developer's address, and one command refreshes it when the address changes. B4: the host firewall no longer lets containers reach any HTTPS address or each other's networks. B5: nothing scores after an attempt ended or past its deadline, and the C09 "no security event" window survives a restart. A new command collects and audits the live host in one step.

## Why
The demo had to be reachable by others; the firewall chain accepted tcp/443 for containers (and an accept there skips Docker's isolation); a late event could change a frozen score; a restart inside the 30 s grace lost the C09 credit.

## What was built
- `scripts/allow-my-ip.mjs` (+test): current public address into `ssh_source_cidrs`, optional `--public-web` (80/443 for everybody), `terraform apply`. Applied with `--public-web`.
- `infra/hosts/vulnmart-egress.sh`: no tcp/443 accept for containers, drops between the container subnets; `vulnmart-audit` check (open 443 accept fails, subnet drops required) and all fixtures; the isolation probe has two new targets (peer network tcp/443, platform event port 9444) and the peer listens on 443; `live-deploy.mjs hooks` installs the egress script and rebuilds the chain.
- `MilestoneEngine`: `is_open` guard (the runtime passes `_attempt_open`: state ready or running and not past the deadline), `recover()` rebuilds the C09 windows (and makes good a lost credit) from the stored events; the runtime runs it at start; a paste after the deadline is refused.
- `scripts/live-audit.mjs` (+test): collects the facts over SSH, redacts environment values and addresses, runs the audit.
- The deployed journey has a new check: after play the orchestrator reports the instance `active` (proves B1 live).

## How it works
See the audit report. The deadline guard compares the event's arrival time with the attempt's `deadline_at`; C09 recovery replays the stored events of running attempts through the same rule code that opens a window, so a restart finishes what the first process started.

## Files changed
infra/hosts/vulnmart-egress.sh, scripts/{allow-my-ip,live-audit,isolation-probe,vmi-audit,live-deploy,e2e-live}.mjs and tests, scripts/fixtures/vmi-audit/*, apps/api/src/vulnmart/{ingest/engine,lab/runtime}.py, tests (ingest window, runtime), docs/runbooks/isolation-vm-i.md, docs/audit, docs/dev/dev1-tanmay.md.

## Decisions made
B3 (the developer, 2026-10-19): the demo is publicly reachable; SSH stays on the developer's address. A 172.x VPC would need the audit's VPC check changed (documented in the code).

## Tests
- Gate, activity and deadline: test_ingest_window (3), runtime tests (2 more), allow-my-ip (4), live-audit (2), vmi-audit and infra-isolation 40, probe 22; terraform test aws 37 and oci 10; cloud-init size limit kept under 16384 by trimming comments.
- Live: probe on vm-i 18 of 18 blocked, control reached; audit on live data 9 PASS; deployed journey 29 of 29 under the new firewall and 30 of 30 on the new code (new activity check passes); security group rules read from AWS: 80 and 443 from 0.0.0.0/0, 22 from one address, 9443 and 9444 between the hosts only.

## Evidence
docs/assets/production-readiness/: e2e-run9-tighter-firewall.json, e2e-run10-b1-b5-b6-live.json, isolation-probe-live-2026-10-19.json, vmi-audit-inputs (refreshed) and vmi-audit-result.txt.

## Problems met and how they were fixed
The probe needs node on the host; a checksum-verified Node binary is fetched into /tmp for the run and deleted. The Alpine stub image cannot run the host's Docker CLI. The cloud-init data went over 16 KiB with my comments; trimmed. A 172.x drop made the old VPC-drop check pass wrongly; the check now looks for the VPC range only.

## Security notes (vulnerable parts only)
Opening 80 and 443 exposes the console, the API (behind session login, CSRF and rate limits) and the lab edge (a ticket is needed). The vulnerable shop is only reachable inside an instance behind the gate.

## Limitations and follow-ups
Reachability from another network is not tested. A timed idle destroy and a restart test of C09 are not run live. SSM is not set up; a locked-out developer runs allow-my-ip from any machine with AWS access.