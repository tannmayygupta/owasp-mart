# S-14: live stream (SSE) and cookies through a Vercel same-origin rewrite with an origin secret

Status: TEMPLATE. The live fields are empty until the developer runs `docs/runbooks/vercel-and-origin.md` (story L-11). Fill only real, redacted results. No secrets, addresses, tokens, project names or account names.

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

## Live results (developer fills)
| Check | Command | Result (redacted) |
|---|---|---|
| Whole run | `node scripts/check-sse-rewrite.mjs --url <url> --direct <origin> --hold 130` | |
| echo-through-rewrite | same | |
| host and forwarding seen (information line) | same | |
| visitor-header-overwritten | same | |
| stream-steady (first event, smallest gap) | same | |
| stream-no-compression, stream-cache-control | same | |
| stream-longest (held seconds or cut time) | same, then once with a larger `--hold` | |
| cookie-passthrough | same | |
| no-shared-cache (public max-age=60 probe response, two callers, `x-vercel-cache` value) | same | |
| request-body-and-query | same | |
| direct-access-refused (status and body) | same | |
| Shape test: `rewrites` plus `headers` with the secret (runbook Part G), or Routing Middleware | runbook Part G | |
| Rotation test (Part G) | runbook | |
| Hobby usage after the run | Vercel dashboard, Usage | |

## Decision this feeds
If every check passes: the rewrite (option 1 of architecture 03) stays the primary path and L-11 can close after P-07. If the stream is buffered or cut early: the ticketed direct stream (plan B) or option 4 (dashboards from the VM) of architecture 03 section 5; both change the design and are the developer's call. Tell Tanmay; do not decide alone.
