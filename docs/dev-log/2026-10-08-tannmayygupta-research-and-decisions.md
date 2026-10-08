# Research phase and locking decisions D-15 to D-27

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, committed locally, not pushed |
| Status | Done; PRD, architecture and work-streams come next |
| Report tag | Methodology: research and decision process |

## Requirements covered
Decisions D-15 to D-27 and research items R-01 to R-12, R-14 in `initial.md`. No code.

## Summary
Eight parallel research streams (RS-A to RS-H) produced notes with options, recommendations, evidence and pick-one decision candidates. The lead session checked the highest-risk claims against primary sources, found conflicts between the notes, and put the decisions to the user in four rounds. Thirteen decisions were locked.

## Why
The user asked to research and lock every unlocked item before the PRD, using industry-ready solutions, with nothing locked until they confirm it.

## What was built
- `docs/research/_BRIEF.md`: shared brief (constraints, research rules, output format).
- `docs/research/RS-*.md`: eight research notes, about 38,000 words in total.
- `docs/research/README.md`: index plus the review log (spot checks and the nine conflicts between streams).
- `initial.md`: decisions D-15 to D-27 with their evidence and caveats; open questions updated.

## How it works (the process)
1. Brief written, eight general-purpose research agents launched in parallel, each told not to modify anything except its own note and not to commit.
2. Lead session read every "Decision candidates" section and the cross-stream impacts, spot-checked claims, and listed conflicts.
3. Decisions were asked as pick-one rounds. The user answered "recommended" each time and repeatedly asked for the industry-driven approach, so a second verification pass checked the time-sensitive facts.

## Files changed
New: `docs/research/*`, this entry. Changed: `initial.md`, `CHANGELOG.md`.

## Decisions made
D-15 hosting (Oracle free VM), D-16 web address, D-17 live updates (SSE), D-18 stored XSS in C03, D-19 platform roles, D-20 C11 KYC fail-open, D-21 stack, D-22 scoring, D-23 isolation, D-24 shop, D-25 privacy, D-26 challenge catalogue, D-27 role rule. Evidence and caveats are in `initial.md` Section 15.

## Tests
Verification by reading primary sources (no code run). **Confirmed:** Cloudflare quick tunnels have no SSE support; OWASP CRS v4.30.0 is the latest; Oracle's Always Free Arm allowance is 2 OCPUs and 12 GB with a 7-day idle reclaim rule; Azure for Students gives $100 for 12 months with no card; Python, Node, PostgreSQL and Next.js support dates (endoflife.date); Redis 8 offers AGPLv3 and Valkey is BSD; fastapi-users is in maintenance mode; OWASP A10:2025 lists CWE-636; Docker `--internal` networks, default seccomp profile and run flags; Coraza is CRS-compatible and supports detect-only mode; Resend free limits. **Not confirmed:** the official DPDP Gazette text (unreadable), Brevo's limits, the GitHub Student Pack contents, NIST and ASVS 5.0 level wording, WSL2 behavior, all capacity numbers.

## Evidence
Links are in `docs/research/README.md` and `initial.md` Section 15. No screenshots.

## Problems met and how they were fixed
1. **Docker internal networks are not fully closed.** Docker's own docs say a container on an internal network can still reach the gateway IP and host services. Added a host-side firewall rule and "bind host services to loopback" to D-23.
2. **Streams contradicted each other** on tunnels versus SSE, the XSS bot, the C11 scenario, capacity assumptions, the Node version, and anti-cheat versus minimal data. Listed in the research README; each was resolved by a user decision or a stated reconciliation.
3. **Tools blocked.** The research agents could not fetch most official pages, so many claims were first UNVERIFIED. The lead session re-verified the high-risk ones.
4. **A search tool failure** (one Oracle search was cut off) was retried.

## Security notes
No vulnerable code yet. The design now treats the host as part of the attack surface (SSRF through the gateway IP) and requires a host-side drop rule, spikes before reliance, and a read-only, no-egress sandbox for the dependency challenge (C06).

## Limitations and follow-ups
- Spikes in Q-31 are not run: certificate for the Oracle VM, SSE through the real path, bot memory, per-instance memory, host blocking on both hosts, Coraza sidecar form, gVisor and rootless.
- Official Gazette text of the DPDP Rules and NIST/ASVS wording must be read before the report.
- The guide must be told about the changes (Q-25).
- Not yet done: PRD, architecture, work-streams and contracts.
