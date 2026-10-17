# VM-I isolation audit and hardening runbook (story 8.5, L-29 lean)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet (working tree) |
| Status | Partly done: parsers, fixtures, `--local` mode and runbook done; no result from `vm-i` exists |
| Report tag | Security: host isolation checking |

## Requirements covered
NFR-ISO-05, NFR-ISO-06, NFR-ISO-07, NFR-SEC-04; spikes S-3, S-8, S-15 (write-up guidance only); D-99 (part, Proposed).

## Summary (plain language, 3-5 lines)
`scripts/vmi-audit.mjs` turns the text output of fixed read-only commands (docker info, daemon.json, iptables listings, docker inspect, listening ports, IMDS setting) into PASS/FAIL/SKIP lines. It runs on saved output folders (`--from`) or on Docker Desktop (`--local`) and changes nothing. The runbook gives you the command bundle for `vm-i`. For NFR-ISO-05 to 07 the state is "checked, not extended": no user namespaces, rootless Docker or gVisor was applied (D-99), and S-8 stays open.

## Why
There was no single read-only view of the labs host isolation or a way to save it as evidence, and a new isolation mechanism two days before a live demo is a bigger risk than the gap it closes.

## What was built
- `scripts/vmi-audit.mjs` (pure parsers exported), `scripts/vmi-audit.test.mjs` (22 tests), fixtures `scripts/fixtures/vmi-audit/good` and nine `bad-*` folders (socket mounted, privileged, no CapDrop, host rule missing, INPUT rule not first, narrow pools, public port, IMDS optional, empty docker info).
- `docs/runbooks/vmi-hardening.md`: Part A (read-only steps and the exact command bundle with the file names the audit reads), Part B (after the demo only: userns-remap, rootless, gVisor, wider pools, each with test first and rollback), Part C (how to write the S-3, S-8, S-15 results).

## How it works
Each check parses one input and fails closed: empty or garbled text gives FAIL "unreadable", a missing required input file gives FAIL, a missing IMDS file gives SKIP. Host-rule checks require the first `DOCKER-USER` rule to jump a lab subnet to `VULNMART-LABS` and the first `INPUT` rules to drop new connections from the lab subnets, and every `default-address-pools` base must lie inside those subnets (CIDR containment). Container checks cover privileged, host network or PID, Docker socket (only `docker-proxy`, read-only), writable binds outside an allow-list, and for instance containers CapDrop ALL and no-new-privileges. Listeners must be loopback or ports 22, 80, 443. Saved evidence is redacted (addresses, account ids, instance ids, key ids).

## Files changed
- `scripts/vmi-audit.mjs`, `scripts/vmi-audit.test.mjs`, `scripts/fixtures/vmi-audit/**` (new)
- `docs/runbooks/vmi-hardening.md` (new)
- `docs/assets/story-8-5-vmi-audit/` (evidence)

## Decisions made
D-99 (part) from the plan: checking, not changing, before the demo. Not recorded in `initial.md` until the developer confirms. No ADR. Judgement calls inside the script (listed so you can change them): the writable-bind allow-list is `/etc/vulnmart`, `/opt/vulnmart`, `/srv/vulnmart` (guessed; adjust to the real host layout); instance containers are recognised by label `vm.instance` or name prefix `vm-i-`; the `daemon.json` `no-new-privileges` default is reported in the detail, not required, because instances set it per container; the default target is 50 instance networks.

## Tests
- `node --test scripts/vmi-audit.test.mjs`: 22 tests, 22 pass, 0 fail (`docs/assets/story-8-5-vmi-audit/unit-tests.txt`).
- `node scripts/vmi-audit.mjs --from scripts/fixtures/vmi-audit/good`: 8 PASS, exit 0 (`fixture-good.txt`). Each `bad-*` folder gives exactly one FAIL line (checked by the test table and by hand on all nine).
- `node scripts/vmi-audit.mjs --local` on Docker Desktop (output `local-audit.txt`): 2 PASS, 2 FAIL, 4 SKIP, exit 1. PASS: docker-seccomp, container-hardening (1 container). FAIL: daemon-pools and daemon-live-restore, because the PC's own `~/.docker/daemon.json` sets neither (a true statement about this PC, not about `vm-i`). SKIP: both iptables lines, listening ports, IMDS. It only reads `docker info`, `docker ps -q` and `docker inspect` and the daemon file.
- Traceability rows: NFR-ISO-05 to 07, NFR-SEC-04 (to be updated by the story owner).

## Evidence
`docs/assets/story-8-5-vmi-audit/` (`local-audit.txt`, `fixture-good.txt`, `unit-tests.txt`). Fixtures use only private test addresses.

## Problems met and how they were fixed
- A first draft of `parseListeners` had a redundant column lookup; simplified to column 4 of `ss -ltnH`.
- `redact` from `scripts/demo.mjs` turns the lab subnet into `<addr>/16` in saved text; accepted (the subnet is not secret but the rule is "no addresses in evidence").
- A test string that looked like an AWS key id tripped `scripts/scan-secrets.mjs`; built it from two pieces.

## Security notes (vulnerable parts only)
Not a vulnerable part. The audit never writes to the host or the network.

## Limitations and follow-ups
- NOT done, developer steps: run Part A on `vm-i` (probe, command bundle, audit, evidence). No live result is claimed anywhere.
- The writable-bind allow-list and the instance-container recognition rule are assumptions to check against the real host the first time the audit runs on it.
- Part B items are documented only; S-8 remains open. A wider address pool is a change to `infra/hosts/**` and needs its own story.
