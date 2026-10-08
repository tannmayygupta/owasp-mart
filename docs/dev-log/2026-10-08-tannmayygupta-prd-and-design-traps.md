# PRD, design traps research and lifecycle choice

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, committed locally, not pushed |
| Status | PRD done; trap decisions locked; architecture and challenge specs still under review |
| Report tag | Requirements and design |

## Requirements covered
The PRD (all areas), decisions D-28 (design traps) and D-29 to D-31 (lifecycle, trackers, tooling).

## Summary
A research agent wrote the PRD from the locked decisions. The lead session read all of it, fixed the Mac chip facts, and found four design traps. Industry practice for each was researched and the user accepted the fixes. The user then chose the development lifecycle (BMAD).

## Why
The architecture and the three developer work-streams must be built on a PRD whose open items are visible, and on a design that avoids security and integration traps before coding starts.

## What was built
- `docs/prd/PRD.md` (about 25,000 words): 170 functional and 49 non-functional requirements, 38 open items, 13 spikes, 18 risks, 16 contradictions between locked decisions and research notes, traceability to D-01 to D-27 and to the synopsis.
- `docs/research/RS-I-design-traps-and-lifecycle.md`: evidence for the four traps and the lifecycle options.
- `initial.md`: D-28 to D-31.

## How it works
The PRD uses only locked decisions; anything undecided became an open item (OI-n) with options. The traps note records each finding as VERIFIED, UNVERIFIED or NOT FOUND with sources.

## Files changed
New: `docs/prd/PRD.md`, `docs/research/RS-I-design-traps-and-lifecycle.md`. Changed: `initial.md`, `docs/research/README.md`.

## Decisions made
D-28: same-origin through a Vercel rewrite (BFF) with a dashboards-on-VM fallback; two separate DuckDNS names with a wildcard certificate for instances; two internal networks per instance with the edge proxy and collector attached into them; self-hosted PostgreSQL and Valkey on the VM, encrypted backups to Oracle storage, Arm images built on the VM. D-29 to D-31: BMAD lifecycle, per-developer trackers plus an Excel mirror, BMAD installed.

## Tests
No code. Verification by reading sources: IETF RFC 10017 (BFF, cookies); Vercel docs (external rewrites, 120-second proxied request timeout); Docker docs (internal networks reach the gateway IP); Let's Encrypt rate limits (50 per registered domain per week); Public Suffix List downloaded and checked (`duckdns.org` listed, `sslip.io` and `nip.io` not listed); Caddy docs (SSE flushed automatically); Oracle Always Free resources; GitHub arm64 runner availability (changelog); Scrum Guide 2020. The PRD was read in full by the lead session.

## Evidence
Sources are listed in `docs/research/RS-I-design-traps-and-lifecycle.md`.

## Problems met and how they were fixed
1. The PRD said Akshay's Mac chip was unconfirmed; the user later confirmed Intel and 16 GB, and Sahil's machine; three lines were corrected.
2. The PRD found that the shop, the platform and instances need separate origins; research showed sslip.io is unsuitable (not on the PSL, shared global certificate limit), which led to the DuckDNS two-name design.
3. Several streams assumed behaviors that needed checking (quick tunnels and SSE; Vercel proxy timeout); each was checked against primary documentation.

## Security notes
Design traps are security design: cross-site cookies, XSS in the shop sharing an origin with the platform, instance networks that still reach the host gateway. Mitigations are recorded in D-28 and D-23.

## Limitations and follow-ups
- Spikes still to run: SSE through a Vercel rewrite, DuckDNS wildcard resolution and certificate, Caddy host routing.
- The PRD has 38 open items; the user's answers are still needed for several (for example OI-9, OI-16 to OI-20).
- Architecture documents and challenge specifications were written by agents and are not yet reviewed or committed.
