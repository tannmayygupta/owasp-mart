---
title: 'VM-I host isolation proof: S-3 host rule on and off, persistence across a Docker restart and a reboot, port scan, S-15 attach timing, and the read-only audit (L-29 part 1)'
type: 'feature'
ticket: '3'
created: '2026-10-18'
status: 'done'
baseline_revision: 'ffcb463'
route: 'full'
risk: 'high'
---

## Intent
**Problem:** the baseline probe passed on vm-i on 2026-10-17, but S-3 (which mechanism blocks the gateway), the behaviour after a Docker restart and a reboot, the externally visible ports, S-15 (edge with many networks) and the read-only audit on the real host had no live result.

**Acceptance criteria** (from the entry `verify`): each step's real output saved under `docs/assets/story-4-1-isolation-probe/`; the probe passes after a Docker restart and after a reboot; the port scan shows only the allowed ports; S-3 and S-15 each get an answer in the research notes; the audit prints PASS or a named FAIL per check; a step a safety check refuses is recorded as not run.

## Plan and what was done
1. Subnet check 3b (read-only): done, valid run.
2. S-3 without touching a firewall rule: the runbook way (delete the two INPUT rules, restore) was refused by the auto-mode safety check, so the probe got `--probe-subnet` and `--peer-subnet` (validated CIDR, off by default, 3 new tests) and was run on subnets outside the covered sets. Result: gateway:22 open there, timeout on covered subnets: the INPUT rule is what blocks.
3. Docker restart and reboot on the empty vm-i: probe PASS after each, rules and units intact.
4. Port scan from the PC: vm-i 22 only; vm-p 22 and 443.
5. S-15: real edge-gate attached to 1, 5, 10, 20 networks by script: restart healthy in 2.4 to 3.3 s, memory flat, attachments survive.
6. Read-only audit on the real bundle: 8 PASS, 0 FAIL.

## Not met inside this story (recorded, not claimed)
Runbook steps 5 to 7 as written were not run; 20 real instances through the orchestrator, the per-hostname check and the post-restart sync delay were not measured (S-15 emulated).

## Verification
`node --test scripts/isolation-probe.test.mjs` 21 passed; live results in `docs/research/s-3-s-15-vm-i-isolation.md` and the evidence folder.
## Progress note 2026-10-18
- Story 4 (S-8 sandboxing, L-29 part 2) stays planned. Prep done: probe --runtime option, 22 tests pass. Live experiments blocked by the auto-mode classifier (daemon config change on vm-i); waiting for the developer's go-ahead.
