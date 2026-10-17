# Live measurements and the isolation baseline on vm-i (L-13 S-4, L-16, L-15 partial)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Partly done (L-16 and S-4 done on the stub image; L-15 partial) |
| Report tag | live, vm-i, measurement |

## Requirements covered
FR-INS-01, 02, 06, 07, 08, 09; NFR-ISO-01 to 04; spikes S-3, S-4, S-15; ADR 0039.

## Summary
Claude ran the runbooks `measure-instances.md` and `isolation-vm-i.md` on vm-i over SSH on the developer's authorisation (Windows OpenSSH with the developer's loaded key). vm-i had no Node and no `uv`: Node 24.21.0 (tarball, checksum verified) went into the home folder and uv 0.12.23 (release binary, checksum verified) into `~/bin`; the measurement ran as root with uv's cache and environment in `/tmp`. The auto-mode safety check refused the S-3 script that removes the host INPUT rules, so that step is left to the developer.

## Tests (real results)
- Baseline probe, host rule on: PASS, 16 forbidden targets blocked, control reached, exit 0, no leftovers.
- S-4: 10 rounds, cold start median 2.12 s, p95 2.81 s, max 2.81 s; 30.4 MiB median per instance; host memory drop 39.5 MiB per instance.
- Concurrent: 10 of 10 ready in 8.04 s; 20 of 20 ready in 16.14 s; p95 8.04 s and 16.13 s; most builds together 4 (the cap); 0 failed, 0 refused, 0 leftovers; host containers and volumes 0 and 0 before and after.

## Problems met and how they were fixed
- Plain `sudo node` could not see Node in the home folder (PATH reset): used `sudo env PATH=...`.
- The runbook's `grep -i vulnmart` finds none of the lab INPUT rules (they have no label); the runbook now greps `ctstate NEW -j DROP`.
- A first read-only check of the firewall gave a wrong count (my own command line matched the pattern, PowerShell mangled it); redone with a script file: two lab INPUT rules, no restore timer, egress unit active.

## Security notes
Nothing secret in the evidence (target names, states, numbers, private Docker subnets, the metadata address as a probe target). The firewall was not changed. No images from the real shop were involved.

## Limitations and follow-ups
Stub image only. S-3 rule-off comparison, subnet check 3b, Docker restart and reboot steps, port scan, S-15 with 20 instances and the socket proxy on vm-i are still open (L-15). The measurement must be repeated with the real images (T-04, L-12). vm-i was left running.
