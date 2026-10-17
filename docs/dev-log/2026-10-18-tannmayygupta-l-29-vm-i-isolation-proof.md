# L-29 part 1: VM-I host isolation proof (story 4.3)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-4-tanmay |
| Status | Done (live, with the gaps listed) |
| Report tag | live, isolation, S-3, S-15 |

## Requirements covered
NFR-ISO-01 to 07, NFR-SEC-04; spikes S-3, S-15.

## Summary
Claude ran the remaining live steps of `docs/runbooks/isolation-vm-i.md` on the empty vm-i over SSH (developer's authorisation). The step that deletes the host INPUT rules was refused by the auto-mode safety check, so `scripts/isolation-probe.mjs` got two options (`--probe-subnet`, `--peer-subnet`) and the S-3 question was answered on subnets outside the covered sets, with no firewall change: gateway:22 is open there, so the per-subnet INPUT rule is what blocks it. Persistence after a Docker restart and a reboot, the port scan, the read-only audit and the S-15 edge measurement followed. Findings: `docs/research/s-3-s-15-vm-i-isolation.md`.

## Tests (real results)
- `node --test scripts/isolation-probe.test.mjs`: 21 passed (3 new; the signal test left the module abort flag set and broke the next test, fixed by resetting it).
- Live: baseline PASS; uncovered variant FAIL on gateway:22 (intended); after Docker restart PASS; after reboot PASS; audit 8 PASS 0 FAIL; port scan vm-i 22 only; S-15 table in the research note.

## Problems met and how they were fixed
- A reboot clears /tmp on vm-i and two reports were lost; they were regenerated into the home folder.
- PowerShell turned the backticks of a JavaScript template literal into nothing in a replacement string; fixed by string concatenation.

## Security notes
The finding is the point: a container on an internal network can reach the host's own ports through the gateway unless the INPUT rule covers its subnet. The daemon pool is inside the covered set, so Docker-allocated networks are covered; a manual subnet outside the set would not be. No firewall rule was changed on vm-i. Reports hold names, states and private subnets only.

## Limitations and follow-ups
The S-15 attach was emulated (no orchestrator, no real instances); the per-hostname check and the post-restart sync delay are not measured. L-29 part 2 (S-8) is the next story. vm-i is still running.
