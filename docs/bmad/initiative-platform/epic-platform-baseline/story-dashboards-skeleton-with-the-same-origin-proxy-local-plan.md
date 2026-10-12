---
title: 'Dashboards skeleton with the same-origin proxy (local)'
type: 'feature'
ticket: '7'
created: '2026-10-12'
status: 'built'
baseline_revision: '51ddcd7675393574a226f9f3fdd9cee611762f90'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/03-origins-and-access.md'
  - '{project-root}/docs/architecture/06-security.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The dashboards' proxy is a bare rewrite: it adds no origin secret, sets no security headers, and nothing shows that one user can never be served another user's API answer (PB-6, EF-02, NFR-SEC-03). Every dashboards story builds on this path.

**Approach:** Put the browser path of architecture 03 in place locally: a Next proxy that rewrites `/api/*` to the API with `x-origin-secret` added, strict security headers with a nonce-based CSP on every page, no-store on every API answer, an origin-secret check in the API as defence in depth, and an end-to-end caching test with two users on the same URL.

## Boundaries & Constraints

**Decisions (developer, 2026-10-12):** (1) The API also checks the secret: when `VULNMART_ORIGIN_SECRET` is set (one or more comma-separated values, for rotation), a request to `/api/*` without a matching `x-origin-secret` answers 403 AUTH-ORIGIN-FORBIDDEN; the internal `/healthz`, `/readyz`, `/version` are exempt; caddy-p (LE-3, stream L) keeps the primary check. (2) The proxy is the Next 16 proxy (the renamed middleware): a rewrite with the header added to the upstream request, the shape of the Vercel rewrite and header transform. (3) CSP is nonce-based with `'strict-dynamic'`, no inline script, `frame-ancestors 'none'`; the dev server alone adds what hot reload needs.

**Always:** The secret is compared in constant time, never logged and never sent to the browser; it comes from the environment (a development value in Compose only). Pages and API answers carry `Cache-Control: private, no-store` (pages: authenticated ones will be; the skeleton applies it everywhere). Headers on every page: CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera, microphone, geolocation, payment and USB, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`; HSTS only when served over HTTPS (production). The request id passes through the proxy; the browser's cookies pass to the API and `Set-Cookie` comes back unchanged. The header and CSP logic is a dependency-free module with unit tests that CI runs (`apps/*/test/*.test.mjs`).

**Never:** No Vercel configuration or deployment (LE-3). No Caddy (stream L). No dashboard pages beyond the health page. No secret in a file other than a Compose development default.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Proxied call | browser `GET /api/v1/health` on the web origin | reaches the API with `x-origin-secret`; 200 `{"status":"ok"}` | — |
| Direct call | `GET :8000/api/v1/health` without the secret, secret configured | 403 IF-8 AUTH-ORIGIN-FORBIDDEN | no hint about the secret |
| Wrong or old secret | header with another value / with the previous value listed for rotation | 403 / 200 | — |
| Probes | `/healthz`, `/readyz`, `/version` without the secret | answered | — |
| No secret configured | API without `VULNMART_ORIGIN_SECRET` | check off (tests, laptop) | — |
| Browser-sent secret | browser sends its own `x-origin-secret` | the proxy overwrites it | — |
| Two users | users A and B, interleaved, same URL, different cookies and request ids | each gets only its own answer; `private, no-store`; no `Age` | — |
| Page headers | `GET /` | all headers of Always; CSP nonce differs per request and matches the page's scripts | — |

</frozen-after-approval>

## Code Map

- `apps/web/next.config.mjs` -- rewrite `/api/:path*` -> `${API_ORIGIN}/api/:path*` (P-06); moves into the proxy; keep `allowedDevOrigins`.
- `apps/web/app/layout.tsx`, `app/page.tsx` -- minimal layout; the health page (client component, `/api/v1/health`); the layout reads the nonce (`headers()`), so pages render dynamically.
- `apps/web/package.json`, `pnpm-lock.yaml`, `Dockerfile` -- Next 16.4.0, React 19.3.0, own lockfile (`--ignore-workspace`); no test script; CI installs only the root workspace, so web unit tests must not import `next`.
- `apps/api/src/vulnmart/kernel/service.py` (`create_service_app`, middleware order), `kernel/settings.py` (`Settings`), `kernel/observability.py` (request ids, redaction: add `x-origin-secret`), `problem.py` (`problem_response`, AUTH-ORIGIN-FORBIDDEN exists in IF-8).
- `infra/compose/compose.yaml` -- `web` (env `API_ORIGIN`) and `api` services: add the dev secret to both.
- `scripts/e2e/platform-stack.e2e.test.mjs` -- the real-Docker test of the platform and web profiles; extend it.
- `docs/dev/HANDOFFS.md` H-107 (to P-04 and P-07: IF-2 0.2.0 changes; nothing to change in a skeleton without lab screens; recorded "to confirm").
- `docs/architecture/03` s1.3-1.4 (x-origin-secret, rules 1-6), 02 s5 (`ORIGIN_SECRET` off locally: now on in Compose), 06 s3 (rotation: accept old and new), s7 (headers).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/lib/security.mjs` + `apps/web/test/security.test.mjs` -- CSP builder (nonce, dev additions), page header set, upstream header set (secret, forwarded host and proto, request id), no-store rules.
- [x] `apps/web/proxy.ts`, `next.config.mjs`, `app/layout.tsx` -- rewrite with the secret, nonce per request, headers on pages and on `/api/*`.
- [x] `apps/api/src/vulnmart/kernel/origin.py` (+ wiring in `service.py`, `settings.py`, redaction) + `apps/api/tests/test_kernel_origin.py` -- the optional check.
- [x] `infra/compose/compose.yaml` -- dev secret for `web` and `api`.
- [x] `scripts/e2e/platform-stack.e2e.test.mjs` -- secret (direct 403, proxied 200), page headers and nonce, two-user caching test; run it and keep the output.
- [x] `docs/architecture/02` s5 row `ORIGIN_SECRET` (on in Compose), `03` (the API check as defence in depth), `docs/dev/HANDOFFS.md` (a row for stream L: the header name and value source for LE-3).

**Acceptance Criteria:**
- Given the platform and web profiles, when the e2e test runs, then a page reaches `/api/v1/health` through the proxy, a direct call without the secret is refused, and two users on the same URL each receive only their own answer.
- Given CI, when `node --test "apps/*/test/*.test.mjs"` and `pytest` run, then the header, CSP and origin-check tests pass; `pnpm --dir apps/web typecheck` passes locally.

## Implementation Notes

- Built directly in the main session. Web: `lib/security.mjs` (+ `security.d.mts` types, unit tests in `test/security.test.mjs`), `proxy.ts` (rewrite with the secret; nonce and CSP for pages; no-store), `next.config.mjs` (fixed headers on every answer, no `X-Powered-By`; the config rewrite is gone), `app/layout.tsx` (reads the nonce, so pages render per request) and `app/globals.css` (the inline `style` attribute would break under the production CSP). API: `kernel/origin.py`, wired in `kernel/service.py` inside the request-id middleware so the 403 carries the request id; `Settings.origin_secret`. Compose: one development secret for `web` (`ORIGIN_SECRET`) and `api` (`VULNMART_ORIGIN_SECRET`).
- The development CSP adds `'unsafe-eval'`, `'unsafe-inline'` for styles and `ws:` for hot reload, because the Compose web service runs the dev server; the production CSP was checked on `next start`: no `unsafe-*`, 10 of 10 scripts carry the nonce, no inline style attribute.
- HSTS and `upgrade-insecure-requests` only when the origin is HTTPS (`DASHBOARD_ORIGIN` in the config, the request protocol in the proxy): on `http://127.0.0.1` they would break the page or be ignored.
- The secret check answers 403 before routing, so an unknown `/api/*` path does not reveal whether it exists to a caller without the secret.
- Not shown end to end yet: `Set-Cookie` coming back through the rewrite (no API route sets a cookie until P-12) and cookies arriving at the API (no route reads them yet; the unit test of `upstreamHeaders` shows they are kept). The e2e test shows each user's answer coming back to that user only.
- The page's own client call under the CSP is not run in a browser (no browser harness in the repository); the e2e test fetches the same URL and checks the CSP allows same-origin connections. Deferred to the first dashboards story with a browser test.
- Review (quick lens): 8 findings fixed, 1 deferred, 1 rejected. After the patches: stack e2e 13 of 13, 951 pytest, 64 app tests, typecheck clean, contract rules 0 FAIL.

## Plan Change Log

## Review Triage Log

### 2026-10-12, quick review (lens: quick), loop 0
Verdicts: 1 high, 5 medium, 3 low, 1 false. All patches applied; one item deferred.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `HANDOFFS.md` got a lone carriage return (whole-file diff); the same defect was already on `main` in `traceability.md` (Git treated it as binary) | high | patch | The row insertion kept the `\r` of the line before it. Both files normalised; row insertions now split lines. |
| 2 | The proxy passed a browser-chosen `x-forwarded-for` / `x-real-ip` next to the real secret (architecture 03 rule 4 trusts the address only with a valid secret) | medium | patch | `DROPPED_FROM_BROWSER`: secret, `x-forwarded-for`, `x-real-ip`, `forwarded`; unit test. |
| 3 | The API check let websocket upgrades to `/api/*` through | low | patch | Websocket scopes are checked and closed with 1008; test. |
| 4 | The secret came only from the environment, against architecture 06 s3 (files under `/run/secrets`); 06 s3 not updated | medium | patch | `VULNMART_ORIGIN_SECRET_FILE` (the file wins); 06 s3 row and H-113 updated; test. |
| 5 | H-113 named the requirement `LE-3` instead of task L-11, and no task pointed to it | medium | patch | Row moved to L-11; `Handoffs: H-113` added under L-11 in `dev1-tanmay.md`. |
| 6 | H-107 was marked answered without the developer's confirmation, and the plan did not list it | medium | patch | Status `answered, to confirm`; listed in the Code Map. |
| 7 | Notes claimed the e2e test shows cookies reaching the API | low | patch | Notes corrected: only the unit test shows it until a route reads cookies (P-12). |
| 8 | The page's own client call under the CSP is not run in a browser | medium | defer | No browser harness in the repository; the e2e test fetches the same URL and checks the CSP. Deferred to the first dashboards story with a browser test (`deferred-work.md`). |
| 9 | Stale comment in `page.tsx` | low | patch | Now names `proxy.ts`. |
| 10 | No evidence folder | false | rejected | Written at close-out: `docs/assets/p-07-dashboards-proxy/`. |

## Verification

**Commands:**
- `node --test "apps/*/test/*.test.mjs"` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass
- `pnpm --dir apps/web install --ignore-workspace --frozen-lockfile && pnpm --dir apps/web typecheck` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (images rebuilt) -- expected: all pass
- `node scripts/check-contract-rules.mjs`, `node --test "scripts/*.test.mjs"` -- expected: 0 FAIL, all pass
