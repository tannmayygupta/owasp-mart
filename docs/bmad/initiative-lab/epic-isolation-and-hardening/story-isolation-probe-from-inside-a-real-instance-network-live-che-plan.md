---
title: 'Isolation probe from inside a real instance network, live checks and the VM-I runbook (S-3, S-15)'
type: 'feature'
ticket: '1'
created: '2026-10-16'
status: 'built'
baseline_revision: '1ee5c019bb1ede4ec4d587476f05023ed514ad17'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** NFR-ISO-01 to 04 say an instance can reach nothing but its own sidecar, but nothing tests that from inside a network built the way the orchestrator builds it. The existing `verify-hosts.mjs` probe runs on a default bridge, not an instance network, and the claim that the host rule is the INPUT drop (spike S-3) and the attach test of the labs edge (S-15) are not done.

**Approach:** `scripts/isolation-probe.mjs` creates an internal network and a hardened probe container with the orchestrator's own profile (internal network, user 65532, read-only, cap_drop ALL, no-new-privileges, limits), plus a sidecar-alias control container and a peer instance network, then tries every forbidden target from inside and the control, and reports blocked or open. It runs locally on Docker Desktop (tested) and on VM-I (a runbook for the developer, never run by Claude). The live conformance checks also assert seccomp is not unconfined and no socket or host path is mounted. Decided on the developer's delegation, recorded as D-57 and ADR 0037 (Proposed).

## Boundaries & Constraints

**Always:** The probe uses only the Docker CLI, creates only objects labelled `vm.kind=isolation-probe` and removes them in every case (also on error and on a second run). Targets: the network gateway address, `host.docker.internal`, the host's docker0 address, a container on another internal network (by address), `169.254.169.254`, a public address on 443 and 53, three RFC1918 addresses (LAN), a platform-like name; control: the sidecar alias on its own network, which must be reachable (otherwise the run fails, because a probe that reaches nothing proves nothing). A target counts as open only on a completed TCP connect; timeout, refusal, unreachable and name-not-found are blocked. The probe exits non-zero when any target is open or the control is not reached. Output contains no secret and no public address of the machine. The runbook lists exact commands for the developer on VM-I: the probe with the host rule on and off (S-3: shows whether INPUT or DOCKER-USER blocks the gateway), after a Docker restart and after a reboot, a port scan note, and the S-15 attach and restart timing with the number of attached networks; and what evidence to save under `docs/assets/`.

**Never:** Running anything on AWS, VM-I or over SSH; changing `infra/hosts/**`, terraform or the daemon address pool (a proposal for a larger pool goes into the runbook and `deferred-work.md`); `.github/workflows/**`; `contracts/**`; privileged containers, host networking or the Docker socket inside the probe; pushes and commits (the developer's session commits). Write the dev-log last but do write it, keep every file without a byte order mark.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Isolated network | local Docker Desktop, internal network | every forbidden target blocked, control reached, exit 0, JSON report | none |
| Open target | a stub runner says one target connected | report marks it open, exit 1 | message names the target |
| Control unreachable | the sidecar alias does not answer | exit 1, "control not reached" | probe is invalid, not "isolated" |
| Leftovers | a previous run was killed | the next run removes labelled leftovers first; at the end nothing labelled remains | none |
| Docker missing | no daemon | exit 2 with a plain message (tests skip) | none |
| Profile check | `docker inspect` of the probe container | user, read-only, cap-drop, no-new-privileges, no mounts, no privileged are asserted | exit 1 on a difference |
| Conformance live check | container with `seccomp=unconfined` or the socket mounted | `seccomp-not-unconfined` and `no-docker-socket` FAIL | rule names the container |

</frozen-after-approval>

## Code Map

- `scripts/verify-hosts.mjs:124-163` -- the existing stdlib TCP probe (`ISOLATION_PY`) and `isolationChecks()`; reuse the classification idea, do not change it. Tests `scripts/infra-isolation.test.mjs`.
- `scripts/check-instance-conformance.mjs:114-142` -- live checks from `docker inspect`; add `seccomp-not-unconfined` and `no-docker-socket`; fixtures in `scripts/conformance-fixtures.mjs`, tests `check-instance-conformance.test.mjs`.
- `apps/orchestrator/src/vulnmart_orchestrator/builder.py:250-307` -- the profile to mirror (RUN_USER, read-only, cap_drop, no-new-privileges, tmpfs options); `contracts/instance/instance-contract.md:134-149` (section 7).
- `contracts/mocks/stub-instance/Dockerfile` -- node-based image `vulnmart-stub-instance:local` (built by `dev.mjs`); the probe may use it with a command override.
- `infra/hosts/vulnmart-egress.sh` (read only) -- the rules the runbook toggles; `docs/runbooks/measure-instances.md` and `docs/runbooks/deploy.md` as style.
- New: `scripts/isolation-probe.mjs`, `scripts/isolation-probe.test.mjs` (unit, runs without Docker; a Docker test is skipped when no daemon), `docs/runbooks/isolation-vm-i.md`, ADR 0037, D-57 in `initial.md`, dev-log, evidence `docs/assets/story-4-1-isolation-probe/`, traceability rows NFR-ISO-01..04, S-3, S-15, handoff answers H-62, H-71 and a row noting S-3/S-15 live results are the developer's.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/isolation-probe.mjs` -- probe and report (injectable `docker` runner for tests)
- [x] `scripts/isolation-probe.test.mjs` -- every matrix row (stub runner) and one real Docker run when a daemon exists
- [x] `scripts/check-instance-conformance.mjs` + fixtures + tests -- two new live rules
- [x] `docs/runbooks/isolation-vm-i.md` -- numbered developer steps with expected output and evidence list
- [x] docs -- ADR, D-57, CHANGELOG, traceability, dev-log, evidence (a real local run), story `built`

**Acceptance Criteria:**
- Given Docker Desktop, when `node scripts/isolation-probe.mjs` runs, then it exits 0 with every forbidden target blocked and the control reached, and `docker ps -a`, `docker network ls` show nothing labelled `isolation-probe` afterwards.
- Given a stub runner that reports one open target, then the exit code is 1.
- Given the node script tests run, `node --test "scripts/*.test.mjs"` shows no new failure.

## Implementation Notes

Built 2026-10-16. The two live rules went into checkInspect (no fixtures file change was needed). Local Docker Desktop run: PASS, 16 forbidden targets blocked, control reached, nothing left over; 86 tests passed. Not run: vm-i (the developer's runbook). The whole-suite run has one failure that exists without this change (generate-api-code.test.mjs, line endings). Handoffs H-62 and H-71 got answer text; the plan names D-57 and ADR 0037, both Proposed.

Review round (2026-10-16): the verdict now fails on a target with no answer or an error state (only timeout, refused, unreachable and name-not-found count as blocked), on a non-zero exit code or an incomplete answer list from the in-container program (which now writes with a callback before exiting); SIGINT and SIGTERM run the labelled cleanup and exit 130; the report holds the probe and peer subnets, the peer must be on another network and subnet, and the probe container gets `--add-host host.docker.internal:host-gateway`; `--image` and `--timeout-ms` are validated (exit 2). Conformance: new rule `security-profiles-not-disabled` (apparmor, label, systempaths), the socket rule covers any `.sock`, named pipes and binds of parent directories. Runbook: one run at a time and manual cleanup, subnet check against `LABS_DOCKER_SUBNETS`, safety-net timer, empty-vm-i warning, evidence list. Deferred: UDP and IPv6 targets, exact tmpfs comparison with builder.py.

## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-16, one focused review lens for false passes, the main risk of a probe).

| Verdict | Route | Finding and evidence |
|---|---|---|
| high | patch | A target with no answer or an `error:*` state counted as not open, so a garbled output that still held the control passed: every target needs an answer in {timeout, refused, unreachable, name-not-found}. Tests: truncated array, error state, missing target. |
| high | patch | The in-container exit code was ignored and parse errors swallowed; output could be cut by `process.exit`: exit code, JSON and length are required, output written with a callback. Test. |
| medium | patch | No SIGINT/SIGTERM handling left objects behind (sleep container 5 min): handlers, cleanup always, exit 130; one run at a time and a manual cleanup line in the runbook. Test. |
| high | patch | S-3 on VM-I could be vacuous (probe subnet outside `LABS_DOCKER_SUBNETS`; `host.docker.internal` unresolvable on Linux): subnets in the report, runbook step 3b compares them, `--add-host host.docker.internal:host-gateway`, peer must sit on another network and subnet. Tests. |
| medium | patch | Conformance rules missed `apparmor=unconfined`, `label=disable`, `systempaths=unconfined`, non-docker `.sock` files and parent-directory binds: new rule and wider socket rule with tests, including a benign container. |
| low | patch | `--image` and `--timeout-ms` not validated; runbook step numbers and states disagree, restart steps need "only on an empty vm-i", no restore timer for the host rule: all fixed in the runbook and script. |
| low | defer | UDP and IPv6 targets; exact tmpfs option comparison with `builder.py`: in `deferred-work.md`. |
| none | reviewer | No shell use, no socket or host mount, cleanup filters only on the exact label: confirmed. |

## Design Notes

A probe on a default bridge proves nothing about an instance network, so the probe builds the network and container the way the orchestrator does. Local Docker Desktop cannot show the host INPUT rule (its host is a VM): the local run proves the internal network; the runbook run on VM-I proves the host rule.

## Verification

**Commands:**
- `node scripts/isolation-probe.mjs` -- expected: exit 0, report saved to evidence
- `node --test scripts/isolation-probe.test.mjs scripts/check-instance-conformance.test.mjs scripts/infra-isolation.test.mjs` -- expected: pass
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
