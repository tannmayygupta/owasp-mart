# Architecture, decision records and the three work-streams

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, committed locally, not pushed |
| Status | Done as a proposal; some decisions accepted (D-28, D-33 to D-35), ten still open |
| Report tag | Design: architecture |

## Requirements covered
All PRD areas at component level (component-to-requirement table in `docs/architecture/01-overview-and-components.md`); decisions D-33 (work split), D-34 (two VMs), D-35 (four refinements).

## Summary
An architecture agent wrote seven design documents (about 27,800 words), an index with an evidence register, and fourteen decision records. The lead session reviewed the work-stream split, the origins and network design and the component table against the locked decisions. The user accepted the split (P, L, T), the assignment (Tanmay L, Akshay P, Sahil T), two Oracle VMs and four refinements.

## Why
Three developers must be able to work independently, with security traps (cross-site cookies, XSS next to the platform, instance networks that reach the host) solved before coding, and with contracts fixed before anyone builds against another stream's code.

## What was built
`docs/architecture/README.md` and `01` to `07`; `docs/adr/0002` to `0015` and an updated ADR index; research note RS-I (traps and lifecycle) used as input. Decisions D-33 to D-35 in `initial.md`; PRD amendment note.

## How it works
Streams meet only at ten contracts (IF-1 to IF-10) with owners, mocks and conformance checks; sprint zero builds contracts, a stub shop and a lab harness first; deadlock rules are listed in `07-repo-and-workstreams.md`. Browsers talk only to the Vercel origin, which proxies `/api/*`; each instance has its own hostname under a separate labs domain, two internal networks and a gate; the edge relays signed sidecar events to ingest; VM-P holds personal data and VM-I runs hostile instances.

## Files changed
New: architecture documents, ADRs 0002 to 0015, this entry. Changed: `initial.md`, `docs/prd/PRD.md` (amendment note), `docs/adr/README.md`, `CHANGELOG.md`.

## Decisions made
D-33 split and assignment; D-34 two VMs (amends D-15); D-35 per-attempt key, ASVS level 3 for key and audit, loopback HTTP for development, catalogue as a second SQLite file. Ten architecture decisions (access gate, live-update design, keystore and audit anchor, rest of the key design, orchestrator proxy and INPUT rule, optional GitHub arm runner, monorepo toolchain, RLS plus app filter, laptop engine, Vercel as sub-processor) still await the user.

## Tests
No code. The lead read `07` in full and the key sections of `01`, `02` and `03`, and grepped `04` to `06` for open points. Checked against sources: Public Suffix List (full list, `sslip.io` and `nip.io` absent), Oracle Always Free page (two A1 instances, 2 OCPUs total), NIST SP 800-190 (secondary summary), Team Topologies and Pact (secondary), Docker firewall page (silent on container-to-host traffic). Not run: any spike (S-14 Vercel rewrite and SSE, S-16 DuckDNS wildcard, S-17 two-VM private link, S-3 host drop rule).

## Evidence
Evidence register EF-01 to EF-30 in `docs/architecture/README.md`; additions in `initial.md` D-33 and D-34.

## Problems met and how they were fixed
1. The architecture agent stalled after seven files (600-second watchdog) before writing the index and ADRs, so the files cited an index and ADRs that did not exist. It was resumed with a narrower task and finished.
2. Two evidence rows were corrected after the lead's own checks (Public Suffix List absence, Oracle two-instance limit).
3. The agent proposed two VMs, which contradicts D-15 and resolves PRD issue P-1; it was put to the user instead of being assumed.
4. The edge acts as the event relay here, whereas the lead's own sketch had a separate collector; the choice and reason are in ADR 0005.

## Security notes
New findings in the architecture: Vercel external rewrites cache upstream responses by default for new projects (use no-store headers and the opt-out header); an instance access gate with ticket and host-only cookie; per-attempt keys; the host drop rule belongs in INPUT, not DOCKER-USER (unverified, spike S-3).

## Limitations and follow-ups
- Architecture documents are proposals except where marked Accepted; ten decisions are open.
- Sprint zero has not started; contracts do not exist yet.
- Unverified: SSE through the Vercel rewrite, DuckDNS wildcard resolution, the INPUT-chain rule, branch protection on a private personal repository, two-VM private link, memory per instance.
