# S-14: live stream (SSE) and cookies through a Vercel same-origin rewrite with an origin secret

Status: RUN LIVE on 2026-10-18 (Claude over SSH and the Vercel CLI, on the developer's authorisation, with a throwaway Hobby project and the probe on vm-p). All ten checks pass on the final shape. Only real, redacted results below: no secrets, addresses or tokens.

## Question
Does a live stream (SSE) pass through a Vercel external rewrite unbuffered, how long can it stay open, do cookies and the origin secret header behave as documented, and is the rewrite free of shared caching? (ADR 0002, ADR 0031, D-50; architecture 03 section 1.3 lists these as not found in any primary source.)

## Facts verified by research on 2026-10-11 (not by a live run)
| Fact | Source |
|---|---|
| `routes` entries accept `transforms` with `type: request.headers`, `op: set`, `target.key`, `args`, and an `env` whitelist; `$VAR` in `args` and in `dest` is replaced from the listed environment variables at request time | https://vercel.com/docs/project-configuration/vercel-json |
| A proxied request may take up to 120 s to be answered; the backend may keep sending as long as data arrives at least every 120 s (changelog) | architecture 03 section 1.3, `[EF-03]`, `[EF-04]` |
| Hobby: a Vercel Function is cut at 300 s (no function runs in this design); non-commercial use only | architecture 03, `[EF-06]` |
| Caddy 2.10.2: `header` matcher, `header_regexp`, `reverse_proxy` `flush_interval -1`, log filter `delete` behave as the gate needs (local e2e test) | `scripts/e2e/caddy-origin.e2e.test.mjs` |

## Not verified (the live run decides)
Maximum total stream length; buffering of SSE on rewrites; the Host header Vercel sends to the origin; `$ORIGIN_SECRET` expansion in a `routes` transform on Hobby; that `set` overwrites a visitor value; `Set-Cookie` and large header passthrough; whether rewrite caching is off for the route; Hobby usage counted by a held stream; whether `rewrites`, `headers` and the secret transform can coexist.

## Limit of the `routes`-only shape (ADR 0031)
`routes` cannot be combined with `rewrites`, `redirects`, `headers`, `cleanUrls` or `trailingSlash`. The real dashboards need security headers and perhaps a single-page fallback. The runbook (Part G) has a step that tests whether `rewrites` plus `headers` can carry the secret transform, and the fallback is Routing Middleware. Record which shape worked below.

## Live results (2026-10-18)
Command: `node scripts/check-sse-rewrite.mjs --url https://<throwaway project>.vercel.app --direct https://tanmay-platform-prod.duckdns.org --hold 130` against the shape in `infra/vercel/s14-probe/vercel.json` (one `routes` entry with the secret transform AND the route-level header `x-vercel-enable-rewrite-caching: 0`). Result: exit 0, `S-14: all checks passed (the live stream works through the rewrite)`.

| Check | Result |
|---|---|
| echo-through-rewrite | PASS: status 200, the origin received the secret header (`$ORIGIN_SECRET` expands in a `routes` transform on Hobby) |
| host-and-forwarding-seen (information) | the origin sees Host = the platform DuckDNS name, `x-forwarded-host` = the same, an edge client address header is present |
| visitor-header-overwritten | PASS: `set` replaces a visitor-chosen value |
| stream-steady | PASS: 6 events, first after about 2.0 s, smallest gap 1.87 s of 2.0 s: not buffered |
| stream-no-compression, stream-cache-control | PASS: no content-encoding; `no-cache, no-transform` kept |
| stream-longest | PASS: held 129 s with heartbeats, no cut (the 120 s mark is passed; a longer limit was not looked for) |
| cookie-passthrough | PASS: Set-Cookie with HttpOnly, Secure, SameSite arrives; a cookie sent back reaches the origin |
| no-shared-cache | PASS on the final shape (user-b gets user-b's body, `x-vercel-cache: MISS`). FAILED first (user-b got user-a's body, `x-vercel-cache: HIT`), see below |
| request-body-and-query | PASS: POST body and query unchanged |
| direct-access-refused | PASS: a request straight to vm-p without the secret is 403 `forbidden` (the Caddy gate) |

## Findings (read before building the real dashboards, handoff H-116)
1. **Shared cache is real (security).** With no opt-out, Vercel cached the origin's `Cache-Control: public, max-age=60` answer and served one visitor's response to another (`x-vercel-cache: HIT`). A top-level `headers` entry for `/api/(.*)` next to `routes` did NOT stop it (deployed, still HIT). The header `x-vercel-enable-rewrite-caching: 0` as a `headers` object INSIDE the route did (MISS, own body). The real API must also send `Cache-Control: private, no-store` on authenticated routes (belt and braces).
2. **The documented `env` expansion works**, but the stored value must be clean. Setting the variable from Windows PowerShell through `ProcessStartInfo` stdin added a UTF-8 byte-order mark: the stored value was `<BOM>value` and every request failed with `X-Vercel-Error: TRANSFORM_INVALID_HEADER_VALUE` (the runtime log of a middleware experiment showed `character at index 0 has a value of 65279`). Even a plain non-secret test variable failed the same way. Setting the value from a Node `spawn` with raw bytes on stdin gave exactly the intended value. In the dashboard or with `vercel env add` typed at the prompt this does not happen. Check any new secret by its length (a BOM is 3 bytes in UTF-8).
3. **Deployment URLs are behind Vercel Authentication**; only the production alias (`<project>.vercel.app`) is public. Test against the alias.
4. **Routing Middleware as a fallback** (a `middleware.js` that sets the header) was started when finding 2 looked like a failure; it is NOT needed and was removed. Keep it as the documented fallback only.
5. `vercel link` writes `.vercel/` and an `.env.local` holding a short-lived OIDC token into the deploy folder; both are git-ignored, delete `.env.local` after use.
6. Port 443 had to be open to the internet for Vercel (it has no fixed addresses): opened for this run only and closed again (security group rules back to the developer's address only).