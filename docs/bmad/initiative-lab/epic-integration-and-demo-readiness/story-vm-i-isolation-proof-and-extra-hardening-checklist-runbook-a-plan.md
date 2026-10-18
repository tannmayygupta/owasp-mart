---
title: 'VM-I isolation proof and extra hardening checklist: runbook and checker script'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/runbooks/isolation-vm-i.md', '{project-root}/docs/architecture/06-security.md', '{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** L-29 wants the isolation tests to pass on VM-I and extra hardening (user namespaces, rootless Docker, gVisor, wider address pools) only where tests pass. The probe (story 4.1) and the socket proxy (4.2) exist. Two days before a live demo, a new isolation mechanism on the demo host is a bigger risk than the gap it closes, and there is no single read-only way to see the host's isolation state or to save it as evidence.

**Approach:** `scripts/vmi-audit.mjs` (built-ins only). Pure functions parse the text of fixed, read-only commands and return `{name, status, detail}` lines: `docker info --format '{{json .}}'` (security options include seccomp, no `userns` claim made unless present; rootless flag; storage driver), `/etc/docker/daemon.json` (default address pools wide enough for the target concurrency: count the /24s available against N instances x 1 network, from the `default-address-pools` list; `no-new-privileges` default, `live-restore`), `iptables -S DOCKER-USER` and `iptables -S INPUT` (the host rule of story 4.1 present and first), `docker ps -q` then `docker inspect` of every container (no `Privileged`, no `/var/run/docker.sock` mount except the service `docker-proxy` read-only, no `NetworkMode host`, no host path binds outside the allow-list, `CapDrop` ALL on instance containers, `no-new-privileges`), `ss -ltnH` (every listening port is loopback or one of 22, 80, 443), and, for the developer to paste, the output of `aws ec2 describe-instances` filtered to `MetadataOptions.HttpTokens` (must be `required`). Two modes: `--from <folder>` reads saved outputs (the VM runbook saves them, so the audit can run on the laptop and in tests), and `--local` runs the same read-only commands against Docker Desktop (skipping iptables and ss with a SKIP line). Output is a table with PASS, FAIL or SKIP and a saved text file with addresses redacted (`redact` from `scripts/demo.mjs`), nothing else printed.

`docs/runbooks/vmi-hardening.md`: Part A (do before the demo, read only): run the existing probe (`isolation-vm-i.md`), run the command bundle the runbook lists into a folder, run the audit, save evidence in `docs/assets/story-8-5-vmi-audit/`. Part B (after the demo only, marked NOT FOR 17 to 19 OCT): one section each for `userns-remap`, rootless Docker, gVisor and wider address pools, each with the test to run first on a throwaway instance, the rollback, and a note that S-8 stays open. Part C: how to write the S-3, S-8 and S-15 spike results.

**Proposed (decided on the developer's delegation):**
- **D-99 (part):** before the demo the hardening work is checking, not changing. No new isolation mechanism (user namespaces, rootless Docker, gVisor, address-pool change) is applied to VM-I between now and 19 Oct; they stay documented as post-demo options with their tests, and NFR-ISO-05 to 07 are reported as "checked, not extended" in the dev-log. A FAIL line from the audit is a finding for the developer to fix with an existing, already tested control (for example re-apply the host rule), not an excuse to add a mechanism.

## Boundaries & Constraints

**Always:** every command in the bundle is read-only; parsers fail closed (an unreadable or empty output is FAIL or SKIP with a reason, never PASS); fixtures cover a good host and one bad host per check; saved evidence has addresses, account ids and key names redacted and holds no flag, token or secret; the audit never talks to the network itself.

**Never:** running anything on VM-I, AWS, ssh or terraform (the bundle is a list for the developer); changing `infra/**`, terraform, daemon settings, firewall rules or compose files; applying userns, rootless or gVisor; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Good host | fixtures of a correct host | all PASS | none |
| Socket mounted | a container mounts the Docker socket and is not `docker-proxy` | FAIL naming the container | none |
| Proxy mount | `docker-proxy` mounts it read-only | PASS | none |
| Privileged | `Privileged: true` | FAIL | none |
| Rule missing | no host rule in `DOCKER-USER` and `INPUT` | FAIL | none |
| Narrow pools | pools allow fewer networks than the target N | FAIL with the numbers | none |
| Public port | a listener on `0.0.0.0` other than 22, 80, 443 | FAIL | none |
| IMDS optional | `HttpTokens: optional` | FAIL | none |
| Empty or garbled output | any command text | FAIL with "unreadable" | none |
| `--local` on Docker Desktop | no iptables or ss | those checks SKIP, the rest run | none |

</frozen-after-approval>

## Code Map

- `scripts/isolation-probe.mjs` and its test (existing probe, run as is), `docs/runbooks/isolation-vm-i.md` (steps and evidence of story 4.1), `scripts/check-network-rules.mjs`, `infra/hosts/**` and `docs/architecture/06-security.md` lines 76 to 89 (read for what the controls are), `infra/compose/docker-proxy/rules.cfg`, `docs/research/RS-B-isolation-orchestration.md`.
- `scripts/demo.mjs` -- `redact`.
- New: `scripts/vmi-audit.mjs`, `scripts/vmi-audit.test.mjs`, `scripts/fixtures/vmi-audit/good/*`, `.../bad-*/*` (text outputs, no real address), `docs/runbooks/vmi-hardening.md`.
- docs: dev-log, CHANGELOG, traceability NFR-ISO-05 to 07 and NFR-SEC-04, evidence `docs/assets/story-8-5-vmi-audit/` (the `--local` run output only), handoff row H-125 follow-up.

## Tasks & Acceptance

**Execution:**
- [ ] parsers and fixtures, one test per check and per failure shape
- [ ] `--from` and `--local` modes; run `--local` once and keep the output
- [ ] `vmi-hardening.md` Parts A to C with the exact command bundle (written so each command saves to a file named in the audit's input list)
- [ ] docs -- dev-log (state plainly that no live result exists), CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given the good fixtures, then every line is PASS; given each bad fixture, then exactly the matching line is FAIL.
- Given `--local` on Docker Desktop, then it runs without changing anything and prints SKIP where the host lacks the tool.
- Given the runbook, then Part A is complete and read-only and Part B is clearly marked as not for the demo window.

## Handoffs (proposed, add rows in the same commit)

- To the developer (live, H-125 follow-up): Part A of the runbook on VM-I the evening of 18 Oct and the result recorded; a FAIL is fixed with an existing control and the audit repeated. No mechanism is added before the demo (D-99).

## Verification

**Commands:**
- `node --test scripts/vmi-audit.test.mjs`
- `node scripts/vmi-audit.mjs --local` (Docker Desktop)
- `node scripts/vmi-audit.mjs --from scripts/fixtures/vmi-audit/good` (expected PASS) and `.../bad-*` (expected FAIL lines)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
