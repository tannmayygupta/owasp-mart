# 0002. Browser-to-API path: same-origin through Vercel rewrites

- **Status:** Accepted by the user (D-28); details below marked "refinement" are Proposed
- **Date:** 2026-10-08
- **Deciders:** the user (D-28)
- **Requirements:** D-15, D-17, D-21; NFR-SEC-03, NFR-SEC-06; FR-ACC-03, FR-LIV-01..06

## Context
Dashboards sit on Vercel, the API on the Oracle VM (another site). Safari blocks and Firefox isolates third-party cookies; Chrome does not block them by default. D-21 chose session cookies; NFR-SEC-03 wants same-origin and no open CORS.

## Options considered
1. Vercel external rewrite of `/api/*` to the VM: first-party cookies, no CORS, no domain needed; Vercel is in the data path.
2. Cross-origin with exact-origin allowlist on one shared domain: needs a domain we do not have.
3. Token auth: conflicts with D-21.
4. Dashboards served from the VM: simplest, leaves Vercel.

## Decision
Option 1 (D-28), with option 4 as the fallback if the SSE test shows buffering. Refinements (Proposed): `__Host-` cookies on the dashboard origin only; origin-secret header checked at the platform edge; `Cache-Control: private, no-store` plus `x-vercel-enable-rewrite-caching: 0`; ticketed direct SSE as an intermediate fallback (needs user OK for exact-origin CORS); server closes streams periodically and clients reconnect with Last-Event-ID.

## Consequences
No third-party cookie problem; API host holds no cookies. Vercel becomes a sub-processor and Hobby is non-commercial (PRD R-4). 120-second proxy limit is covered by 15-second heartbeats. Spike S-14 must confirm SSE, cookies and usage counting.

## Evidence
https://vercel.com/docs/rewrites (VERIFIED); https://vercel.com/docs/limits (VERIFIED); https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes (VERIFIED, partial); https://vercel.com/docs/plans/hobby (VERIFIED); https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies (VERIFIED); SSE through rewrites: UNVERIFIED. See docs/architecture/03-origins-and-access.md.
