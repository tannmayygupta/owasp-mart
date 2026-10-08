# Research notes

Process (agreed with the user, 2026-10-08): **research -> user confirms -> lock in `initial.md` -> PRD -> architecture -> three independent work-streams.**
Nothing here is a decision until the user confirms it and it is recorded in `initial.md` Section 15.

Shared rules and output format: [_BRIEF.md](_BRIEF.md).

| Stream | Topic | File | Status |
|---|---|---|---|
| RS-A | Hosting on free tiers, topology, capacity | RS-A-hosting-capacity.md | Done, under review |
| RS-B | Isolation, orchestration, flags, traffic monitor | RS-B-isolation-orchestration.md | Done, under review |
| RS-C | Scoring, time taken, anti-cheat, assessment sessions | RS-C-scoring-integrity.md | Done, under review |
| RS-D | Platform stack, contracts, security, roles and lifecycles | RS-D-platform-stack.md | Done, under review |
| RS-E | Challenges C01-C06 | RS-E-challenges-01-06.md | Done, under review |
| RS-F | Challenges C07-C11 | RS-F-challenges-07-11.md | Done, under review |
| RS-G | Shop domain, shop roles, refunds, bots, seeding | RS-G-shop-domain.md | Done, under review |
| RS-H | Privacy and data lifecycle | RS-H-privacy-lifecycle.md | Done, under review |

## Review log (2026-10-08)

### Independent spot checks by the lead session
| Claim | Result | Source |
|---|---|---|
| Cloudflare quick tunnels: no SSE, 200 in-flight requests, no uptime guarantee, no account or domain needed, testing only | **VERIFIED** | [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) |
| OWASP CRS latest release is v4.30.0 (2 October; previous v4.29.0, v4.28.0) | **VERIFIED** (page shows no year; v4.25.2 notes mention 2026) | [CRS releases](https://github.com/coreruleset/coreruleset/releases) |
| Oracle Always Free Ampere A1 = 2 OCPUs and 12 GB (1,500 OCPU-hours and 9,000 GB-hours per month); up to two instances; 200 GB block storage; idle instances may be reclaimed after 7 days of low CPU, network and memory use (all under 20%) | **VERIFIED** on Oracle's own page. Third-party reports say the cut from 4 OCPUs and 24 GB took effect 15 June 2026 and disagree on whether pay-as-you-go accounts are affected (UNVERIFIED) | [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Linuxiac](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/) |
| Azure for Students: $100 credit within 12 months, no credit card, 750 hours each of B1s, B2pts v2 (Arm) and B2ats v2 burstable VMs for 12 months, one account per person, full-time university students | **VERIFIED** on Microsoft's page (country eligibility not listed there) | [Azure for Students](https://azure.microsoft.com/en-us/free/students) |
| GitHub Student Developer Pack: partner offers, domain, credits | **UNVERIFIED** (search summaries only; DigitalOcean's student credit reportedly ended 31 July 2026; Namecheap domain not confirmed) | search results |

### Conflicts between streams (to resolve before the PRD)
1. **Live updates versus tunnels.** RS-D recommends SSE; RS-A lists a Cloudflare *quick* tunnel as an option, and quick tunnels do not support SSE (verified). A named tunnel or our own HTTPS host is needed. Also, an online API needs a secure web address, which needs a domain or a free dynamic-DNS name.
2. **Stored XSS and the support bot.** RS-E drops stored XSS from C03 (SQL injection only). The synopsis explicitly describes a payload that runs "inside another simulated user's session", and RS-G designed a headless-browser bot for it. Dropping XSS leaves the bot unused.
3. **C11 changed.** RS-F moved C11 from "payment fails open" (the D-09 idea, marked ideas only) to "seller KYC check fails open". Needs the user's confirmation.
4. **Capacity assumptions differ.** RS-A assumed a database container per instance; RS-G chose SQLite (no database container); RS-F adds one mock-services container; the bot adds a headless browser; RS-B adds a proxy sidecar. The ~400 MB per instance estimate must be re-measured (spike).
5. **Node version.** RS-G proposes Node 22, RS-D proposes Node 24 LTS. One version across the repo is simpler; the C06 exploit must be tested on it.
6. **Anti-cheat versus minimal data.** RS-C's activity-versus-capture check needs activity records; RS-H stores only the flag-capturing request (D-12 minimal data). Resolution proposed: store activity metadata (timestamps, counts, rule tags) without request bodies.
7. **D-12 wording.** RS-H found the 48-hour pre-erasure notice appears to bind only very large e-commerce, gaming and social media companies (unverified; needs the official Gazette text). Auto-delete stays as our own product choice.
8. **Roles carrying challenges (D-11 rule).** Admin, support agent and finance carry no challenge in C01 to C06. RS-F gives finance (C07) and support agent (C09) a role as target, and admin is only the bypassed approver in C11. Whether being a target or victim counts as "carrying" a challenge is the user's call.
9. **One instance holds all 11 challenges.** "Time per challenge" is really time into the assessment unless the classifier is accurate; milestones per challenge (RS-C) are not yet defined in the challenge cards.
