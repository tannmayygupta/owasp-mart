# Dashboards skeleton with the same-origin proxy (P-07, story 1.7)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-6 / local commit, not pushed |
| Status | Done; handoff H-113 to Tanmay for the edge check in `caddy-p` (L-11) |
| Report tag | dashboards, same-origin proxy, security headers, BMAD cycle |

## Requirements covered
PB-6 (dashboards skeleton with the same-origin proxy, origin secret, no-store and security headers; local caching test). Related: NFR-SEC-03, NFR-SEC-05, EF-01, EF-02, D-28, architecture 03 section 1, 06 sections 3 and 7, handoffs H-107, H-113.

## Summary (plain language, 3-5 lines)
The dashboards now reach the API the way production will: the browser talks only to the dashboard origin, and the proxy forwards `/api/*` to the API with a secret header that the browser never sees. The API refuses its browser routes without that secret. Every page carries a strict Content-Security-Policy with a fresh nonce per request and the usual security headers, nothing is cached, and a test shows two users on the same URL never receive each other's answer.

## Why
Every dashboards story builds on this path; architecture 03 and EF-02 name the caching trap of external rewrites, and NFR-SEC-03 asks for CSP and the standard headers.

## What was built
- `apps/web/lib/security.mjs` (dependency-free, unit-tested in CI): CSP builder, fixed headers, upstream headers (secret set, forgeable forwarding headers dropped), URL mapping.
- `apps/web/proxy.ts` (Next 16 proxy): `/api/*` rewritten to the API with `x-origin-secret`, no-store; pages get the nonce and CSP. `next.config.mjs` adds the fixed headers to every answer; the layout reads the nonce; styles moved to a stylesheet.
- `apps/api/src/vulnmart/kernel/origin.py`: the API's own check (403 AUTH-ORIGIN-FORBIDDEN, websocket upgrades closed, several values for a rotation, a secret file in production, probes exempt).
- Compose: one development secret for web and API. End-to-end test extended: secret, page headers and nonce, two-user caching test.
- Docs: architecture 02, 03 and 06 updated; H-113 for Tanmay (L-11); H-107 recorded.

## How it works
The browser calls `/api/v1/health` on the dashboard origin. The proxy copies the request, removes anything a browser could forge (a secret, a client address), adds the real secret, and forwards it to the API with the same path. The API compares the secret in constant time and answers; the answer comes back marked never-cache. Pages get a new random nonce each time, and only scripts carrying it may run.

## Files changed
- `apps/web/lib/security.mjs`, `lib/security.d.mts`, `proxy.ts`, `test/security.test.mjs`, `app/globals.css` (new); `next.config.mjs`, `app/layout.tsx`, `app/page.tsx`
- `apps/api/src/vulnmart/kernel/origin.py`, `apps/api/tests/test_kernel_origin.py` (new); `kernel/service.py`, `kernel/settings.py`
- `infra/compose/compose.yaml`, `scripts/e2e/platform-stack.e2e.test.mjs`
- `docs/architecture/02-deployment-and-network.md`, `03-origins-and-access.md`, `06-security.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md` (Handoffs line under L-11), `docs/traceability.md` (also its line endings fixed), `CHANGELOG.md`, `docs/dev/dev2-akshay.md`, the story plan

## Decisions made
No ADR. By the developer on 2026-10-12: (1) the API checks the origin secret too, as defence in depth behind `caddy-p`; (2) the Next 16 proxy with a rewrite and header, the shape of the production Vercel rewrite; (3) a nonce-based CSP. While building: HSTS and `upgrade-insecure-requests` only over HTTPS; the development CSP alone allows what hot reload needs; the check answers before routing so unknown routes are not revealed.

## Tests
All on the developer's Windows 11 PC, Node 24.11.0, pnpm 12.10.1, uv 0.12.23, Docker 28.5.1. Outputs in `docs/assets/p-07-dashboards-proxy/`.
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` on the real Compose stack: 13 of 13 (direct call without the secret 403, forged secret replaced, page CSP nonce fresh per request and on every script, fixed headers, two users interleaved on the same URL each get their own answer, no `Age`).
- `node --test "apps/*/test/*.test.mjs"`: 64 pass (9 new). `pnpm --dir apps/web typecheck`: clean. A production `next build` and `next start` showed a CSP without `unsafe-*`, 10 of 10 scripts with the nonce and no inline style.
- `uv run --locked --package vulnmart-api pytest -q`: 951 passed, 7 skipped (Postgres tests). `node --test "scripts/*.test.mjs"`: 581 of 581. Contract rules: 0 FAIL.
- NOT run: a real browser executing the page under the CSP (no browser harness yet); CI on a pull request.
- Traceability row: PB-6 in `docs/traceability.md`.

## Evidence
`docs/assets/p-07-dashboards-proxy/`. Review log: Review Triage Log of the story plan.

## Problems met and how they were fixed
- The inline `style` attribute of the layout would break under the production CSP: moved to a stylesheet.
- A broad process kill during a manual production check: corrected to start and stop one server by its process id.
- Independent quick review: a lone carriage return in `HANDOFFS.md`, also found in `docs/traceability.md` on `main` (from row insertions in P-04 to P-06, which made Git treat the file as binary): both normalised; the proxy also passed browser-chosen forwarding headers next to the real secret (now dropped); websocket upgrades bypassed the API check (now closed); the secret could only come from the environment (now also a file, as architecture 06 asks); H-113 named a requirement instead of task L-11 (fixed, and pointed to from L-11); notes overstated the cookie evidence (corrected).

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant platform code: the proxy's header rules, the API's origin check, the CSP and headers. The only secret value is a Compose development default.

## Limitations and follow-ups
- Not pushed or merged. Tanmay: H-113 (the `caddy-p` check and the secret in Vercel, Caddy and the API secret file) for L-11.
- `Set-Cookie` through the rewrite and cookies at the API are shown only in unit tests until a route uses cookies (P-12).
- The page's client call under the CSP is not run in a real browser; to add with the first dashboards story that has a browser test.
