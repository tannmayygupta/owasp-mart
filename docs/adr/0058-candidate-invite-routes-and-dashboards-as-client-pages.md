# 0058. Candidate invite routes, and the dashboards as client pages over the same-origin API

- **Status:** Proposed (the builder's design for the developer to confirm; the developer chose to add the candidate invite routes in P-26 on 2026-10-20)
- **Date:** 2026-10-20
- **Deciders:** Claude Code (design); the developer (scope of the invite routes)
- **Requirements:** FR-DSH-01, FR-DSH-04, FR-HNT-01, FR-HNT-02, FR-ASM-04, OI-15 (answered 2026-10-18), ADR 0050, ADR 0051, handoffs H-134, H-135

## Context
The dashboards app was a one-page tracer bullet (P-07), and a candidate could not accept an invite over HTTP: `InviteAcceptance` (P-21) had no routes ("story 5.3"). The learner and candidate dashboards need the invite routes, the account pages the mails link to (H-134), the second-factor pages (H-135) and the two dashboards. Questions: which invite routes and errors, how the pages are built (server or client rendering, libraries), how live state reaches the page, and how the "results after release" rule (OI-15) is honoured when the lab answers results to their owner either way.

## Options considered
1. **Invite routes:** all of story 5.3 now / only the candidate side (open, accept, mine) now, the recruiter side with P-27 or 5.3.
2. **Errors:** new invite codes / the existing `AUTH-TOKEN-INVALID` and `ATT-INVALID-STATE`.
3. **Pages:** server components that call the API from the Next.js server / client components that call the same-origin `/api` path through the proxy (P-07).
4. **Libraries:** a UI kit, a data-fetching library / none (React and the platform's `fetch` and `EventSource`).
5. **Results rule:** enforced only in the page / in the page and handed to the lab's routes (IF-2, stream L) for the server.

## Decision
- **Candidate routes only** (the developer's choice): `openInvite` (no session, rate limited per visitor like the email links; answers the assessment's description and never the invite's address), `acceptInvite` (session and CSRF; answers the attempt id the consent screen is for), `listMyInvites` (the invites bound to the caller, policy `own_invite` and an explicit filter). The recruiter side stays for P-27 or story 5.3.
- **No new error codes:** a link that opens nothing is 400 `AUTH-TOKEN-INVALID`; a closed or taken invite, an account that cannot take an assessment and an account whose address differs are one 409 `ATT-INVALID-STATE`, because the answer must not say what the invite's address is. The page explains the three possibilities in words.
- **Client pages over the proxy:** every page is a client component that calls `/api/v1/...` on its own origin, so the browser's session cookie and CSRF token are used as they are and the Next.js server holds no session; the CSP nonce and headers of P-07 stay as they are. No new dependency.
- **Live state:** `EventSource` on `/api/v1/live` with the snapshot and polling as the fallback (ADR 0052).
- **Results:** the candidate page shows the score and the report only when the invite's `results_visibility` is `after_submit` and the attempt is submitted; for `after_release` it says the company will release them. The lab's score and report routes still answer the owner; a server-side rule is handed to stream L.

## Consequences
- A candidate can go from the invite mail to the running assessment on the dashboards.
- The 409 is less precise than three codes; the page cannot say which reason applied.
- Until stream L enforces `after_release` in IF-2, a candidate who calls the lab's routes directly can read their own results early (their own data only).
- The recruiter side of invites still has no routes.

## Evidence
- `apps/api/tests/test_invite_api.py`; the web tests and the stack test: see the dev-log of P-26.
