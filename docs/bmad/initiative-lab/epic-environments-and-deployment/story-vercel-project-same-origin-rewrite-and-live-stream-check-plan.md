---
title: 'Vercel same-origin rewrite, origin-secret check and live-stream check (preparation; live steps are the developer''s)'
type: 'feature'
ticket: '3'
created: '2026-10-11'
status: 'done'
baseline_revision: 'b493a689ab1dd7e5d1afafaa3d1680a55c9580b1'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** LE-3 needs the dashboards to reach the platform API through a same-origin Vercel rewrite with an origin secret, and needs the live stream (SSE) proven through that rewrite (spike S-14). No Vercel config, no origin-secret check in the platform Caddy and no S-14 test exist; the real dashboards skeleton (P-07) and the live certificates (L-10) are still missing.

**Approach:** Build and prove locally everything that needs neither: the Vercel route with a header transform, a Caddyfile with the origin-secret gate and unbuffered streaming (tested end to end in Docker with stock Caddy), a throwaway probe project and probe upstream for the real VM, and the S-14 check script. The live deployment and the final wiring with Akshay's skeleton are the last boxes.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-11: delegated design, free things only): D1 The secret header is set by a Vercel `routes` entry with a `request.headers` transform from a sensitive environment variable `ORIGIN_SECRET` (documented by Vercel; `set` overwrites a visitor's value); no Middleware or Function proxy (a Hobby function is cut at 300 s; an external rewrite may stream while data arrives at least every 120 s). D2 The origin keeps the `/api` prefix (IF-2 uses `/api/v1/`, Caddy routes by prefix); the prefix-stripping line of architecture 03 is superseded. D3 Caddy gate: exact `x-origin-secret` match (Caddy has no constant-time compare), 403 otherwise, two accepted values for rotation, secret read from files, never logged; the application repeats the check with a timing-safe compare (handoff to Akshay). D4 SSE: heartbeat comment every 15 s, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, event ids, `retry`, no compression, no caching of rewrites. D5 Stock Caddy image pinned by digest, no plugin (D-49); certificates from the files of L-10. D6 Free only: Vercel Hobby (non-commercial use; coursework fits, recorded as a judgement), no paid add-on. D7 vm-p port 443 must be reachable from the internet because Vercel publishes no address range: the developer sets `public_web_cidrs` and applies; the secret is the protection. D8 The S-14 project is a throwaway static probe in `infra/vercel/s14-probe/` deployed with the CLI after `vercel login` (no token in any file); Hobby Git deployment only accepts commits of the team owner, so real deployments are done by the owner.

**Never:** a secret, token, address or account name in any file; Claude runs no vercel, ssh, terraform or AWS command; no push; no change to Akshay's `apps/web` or `apps/api`; no claim that SSE works through Vercel before the live run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No secret | request without the header | 403, upstream not called | none |
| Wrong secret | other value | 403 | none |
| Right secret | current value | proxied, upstream sees the client address header | none |
| Rotation | old and new files present, then old removed | both accepted, then only the new | none |
| SSE | stream with events 1 s apart | events reach the client spread over time, not at the end | none |
| Logs | any request | the secret never appears in the access log | none |
| No secret file | file missing at start | Caddy refuses to start or refuses every request (fail closed) | exit non-zero |
| Probe through Vercel | `check-sse-rewrite.mjs --url` | steady events, longest stream, cut time, cookie passthrough, cache check, no-secret direct access refused | exit 1 on a failed check |
| Bad config | invalid `vercel.json` shape | the offline validator names the problem | exit 1 |

</frozen-after-approval>

## Code Map

- `infra/caddy/` (only `.gitkeep`): new `Caddyfile.p` (platform: TLS from `/opt/vulnmart/certs/live/`, the gate, `reverse_proxy` with `flush_interval -1`, log filter), a test variant without TLS, the probe upstream (Node, pinned `node:24.21.0` image already used by the repo), a compose file for vm-p; `infra/compose/compose.yaml` only has `hello`.
- `infra/vercel/s14-probe/` new: `index.html`, `vercel.json` (`routes` with the transform per Vercel's "Restricting your origin to Vercel traffic").
- New: `scripts/check-sse-rewrite.mjs` (+ test, injected fetch; pattern of `scripts/check-duckdns.mjs`: pure checker, `parseCli`, USAGE, exit 0/1/2, nothing sensitive printed), `scripts/e2e/caddy-origin.e2e.test.mjs` (Docker, stock Caddy), a CI step in job `compose` of `.github/workflows/ci.yml`.
- Docs: ADR 0031, D-50, `docs/runbooks/vercel-and-origin.md` (layout of `certificates.md`), `docs/research/s-14-vercel-sse.md` (template of `s-16-duckdns-wildcard.md`), architecture 03 notes (prefix, hosts), handoffs for Akshay (prefix, app-level compare, heartbeat), for L-12 (compose, mounts), for L-13 none; traceability LE-3.
- Verified by research (official Vercel and Caddy pages, 2026-10-11): route transform syntax; 120 s proxied-request limit; Hobby limits and fair use; Caddy `header` matcher, `flush_interval`, log filter. Unverified: maximum total stream length, buffering of SSE on rewrites, the Host header sent to the origin, `{file.}` placeholders inside a header matcher (the e2e test decides).

## Tasks & Acceptance

**Execution:**
- [x] `scripts/e2e/caddy-origin.e2e.test.mjs`, `infra/caddy/Caddyfile.p` and the test variant -- the gate, rotation, SSE flush, log redaction, fail closed (tests first, stock Caddy in Docker) -- the matrix
- [x] `infra/caddy/` probe upstream and compose, `infra/vercel/s14-probe/` -- probe endpoints: stream, echo of headers, cookie, cached-body user check -- what S-14 needs on the real VM
- [x] `scripts/check-sse-rewrite.mjs` and test -- the S-14 checks run from the developer's PC -- spike S-14
- [x] offline validator for `vercel.json` (in the same script or a test) -- the transform shape, env whitelist, no secret value in the file
- [x] `.github/workflows/ci.yml`, `scripts/ci-*` tests -- run the Caddy e2e in job `compose` -- CI
- [x] ADR 0031, `initial.md` D-50, runbook (developer steps: Vercel login, project, sensitive env var, secret files on vm-p, port 443, probe up, S-14 run, rotation test), research template, architecture 03 notes, handoffs, dev-log, CHANGELOG, traceability -- documentation rule

**Acceptance Criteria:**
- Given stock Caddy in Docker, when the matrix is run, then every row behaves as written.
- Given the runbook, when followed, then each developer step has a check and no secret or token enters a repository file.
- Given the repository, when scanned, then no secret, token, address or account name appears.
- Given the plan, when the story is reviewed, then the live Vercel run, the S-14 result and the wiring with P-07 are listed as open boxes, not claimed.

## Implementation Notes

Done 2026-10-12 (preparation only; the live steps remain the developer's and are open boxes, not claimed):
- Gate and stream: `infra/caddy/origin-gate.caddy` (imported by `Caddyfile.p` and by the test variant `Caddyfile.test`, so the tests exercise the real gate), `compose.p.yaml`, `probe/server.mjs`. Tests first in `scripts/e2e/caddy-origin.e2e.test.mjs` against stock Caddy 2.10.2 (digest pinned in `compose.p.yaml`) and the probe, both in Docker.
- Unverified items decided by the e2e test: `{file.}` placeholders inside a `header` matcher work and are read per request (rotation needs no reload); a header with an EMPTY value matches an EMPTY or missing file, so the gate has an extra `header_regexp X-Origin-Secret .+` line (found by the fail-closed rows); the access log filter is not enough because the reverse proxy's own warning lines print request headers, so the default logger deletes `X-Origin-Secret` too (found by the log row). `{file.}` with the expression matcher did not work (syntax error), so the plain header matcher is used.
- S-14 files: `infra/vercel/s14-probe/vercel.json` follows the documented `routes` + `transforms` + `env` shape (read from the Vercel `vercel.json` reference on 2026-10-11); only transform args are documented to expand variables, so the committed file has a placeholder host (`REPLACE-WITH-PLATFORM-NAME.duckdns.org`) and `check-sse-rewrite.mjs --render <origin> --out <dir>` writes a git-ignored copy with the real host (refuses anything but `https://<label>.duckdns.org`); the secret stays a `$ORIGIN_SECRET` transform arg with an env whitelist (review fix, change 6 of the triage log). `scripts/check-sse-rewrite.mjs` (live checks, `--validate` offline validator) is tested against the real probe through good and broken stand-in proxies in `scripts/check-sse-rewrite.test.mjs`.
- CI: step `node --test scripts/e2e/caddy-origin.e2e.test.mjs` in job `compose`, pinned by a test in `scripts/ci-workflow-shape.test.mjs` (also checks the digests and that there is no plugin build).
- Docs: ADR 0031, D-50 (after D-49), runbook `docs/runbooks/vercel-and-origin.md`, `docs/research/s-14-vercel-sse.md` (template), architecture 03 update note, handoffs H-116 (Akshay) and H-117 (L-12), dev-log, CHANGELOG, traceability LE-3 and D-50.
- Open boxes (not done, not claimed): live Vercel project and deployment, the sensitive environment variables, the secret files on vm-p, port 443 opened, the S-14 run and its result, the rotation test on the real host, the wiring with Akshay's skeleton (P-07), certificates (L-10), the application's timing-safe re-check (H-116). Status of the story stays in-progress; L-11 is not ticked.
- After review (2026-10-12): the gate also requires exactly 64 lower-case hex and refuses a non-hex secret file; the admin endpoint is a unix socket so `caddy reload` works; the e2e test starts the real `Caddyfile.p` with the compose flags over TLS and covers the missing-secret-file case; the S-14 script and the probe were hardened; `.vercel` and local env files are ignored and scanned. **The story stays in-progress after review because the live steps are open** (the workflow sets the frontmatter status to built; that value is the workflow's and does not mean the live steps are done).
- Not changed: README.md, `apps/web`, `apps/api`. Nothing committed or pushed.
## Plan Change Log

## Review Triage Log

Pass 1 (thorough; lenses: blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Intent Alignment: reading A (local proof of the Caddy side, the Vercel side documented and unproven) is implemented; the production Caddyfile and compose are only adapted or parsed, never started. No intent_gap, no bad_plan: no loopback.

| # | Finding (lens) | Verdict | Route | Evidence |
|---|---|---|---|---|
| 1 | The secret filter of the default logger in Caddyfile.p is pinned by no test (verification-gap) | medium | patch | the log test runs Caddyfile.test; the adapt test counts header names that appear anyway |
| 2 | S-14 checks visitor-header-overwritten and cookie-passthrough have no failing-case test (verification-gap, blind) | medium | patch | the test rig has no passthrough or cookie-dropping mode |
| 3 | `admin off` makes `caddy reload` after a certificate renewal impossible (blind) | medium | patch | H-115 plans `docker exec caddy caddy reload`; the admin API is off |
| 4 | The production compose shape was never started; a missing single-file bind source becomes a directory and a replaced file keeps the old inode (blind, edge) | medium | patch | only `compose config` and `caddy adapt` ran |
| 5 | e2e tests share and mutate state, assertions inside response callbacks, no try/finally, bind-mount timing on Docker Desktop (blind, edge) | medium | patch | rotation sets the secret that later tests assume |
| 6 | `vercel.json` expands `${ORIGIN_URL}` in `dest`; the documented expansion is only for transform args (blind, edge, coordinator) | medium | patch | a wrong guess fails the live run on configuration |
| 7 | The offline validator crashes on a non-object transform, accepts `routes` next to redirects/headers/cleanUrls/trailingSlash, and passes a short secret literal (verification-gap, edge) | medium | patch | the code reads `x.type` unguarded and only rejects `rewrites` |
| 8 | A secret file that starts or ends with `*` is a wildcard in Caddy's header matcher (edge) | medium | patch | a lone `*` would match any non-empty header |
| 9 | Probe stream with a missing or empty interval parameter ticks every 10 ms without a bound (edge) | medium | patch | `Number(null)` is 0 and falls to the minimum |
| 10 | The checker's non-stream fetches have no timeout; SSE frames are matched per network chunk; the cache check passes because the probe sends no-store (edge) | medium | patch | a chunk-split event gives a false FAIL; an uncacheable origin hides an enabled rewrite cache |
| 11 | S-14 does not check Content-Encoding, no-transform survival, POST body and query passthrough; direct-access passes on any 403; steady-stream passes with 1 s batching (blind) | low | patch | D4 requires no compression |
| 12 | `routes` cannot be combined with rewrites, redirects or headers as far as known; the real dashboards need security headers (blind) | medium | patch (docs) | the ADR does not record the limit or the Middleware fallback |
| 13 | Missing documentation: 443 published although H-100/H-103 (state the dependency), rotation of the application's own store and live streams, pinned image refresh, the secret file format, write in place, residual risk of an open 443 with only the secret, stale prefix diagram in architecture 03, runbook says seven PASS but eight print (blind, edge, verification-gap) | low | patch (docs) | each statement is missing or wrong in the diff |
| 14 | `.vercel` and `.env*.local` are not ignored, a `vercel link` would add project IDs (edge) | medium | patch | no .gitignore entry, no scan rule |
| 15 | Traceability rows are incomplete (S-14, NFR-SEC-03, D-15, D-21 touched) (blind) | low | patch | only LE-3 and D-50 added |
| 16 | test-output.txt is a filtered summary and the full-suite figures predate the final fixes (blind, edge) | low | patch | CLAUDE.md rule 5: real output |
| 17 | dev1-tanmay.md: two status notes lost their code backticks and `node` was split (blind) | medium | patch (done by the coordinator) | PowerShell backtick escapes in my own earlier commands; both lines rewritten, no other damaged line found |
| 18 | Story status wording inconsistent and the triage log empty (blind, edge, verification-gap) | low | patch | this log; the status note is aligned by the workflow |
| 19 | Whether the transform expands and overwrites, SSE length and buffering through the rewrite, the Host header, rewrite caching header (intent-alignment, blind) | maybe-false (medium if wrong) | defer | only the live S-14 run can settle it |
| 20 | D-50 recorded as Proposed before the developer confirms (blind) | low | reject | same practice as D-49; stays Proposed until the live run |
| 21 | Dates 2026-10-11 and 2026-10-12, and the identifiers LE-3, L-11 and 2.3 mixed (blind) | low | reject | the work crossed midnight; the traceability row ties the three together |
| 22 | The CI job `compose` is not shown to have Docker and the digests (verification-gap) | low | reject | the job already runs Docker commands (hello, harness) |
## Design Notes

Why `routes` and not Middleware: Vercel documents the transform for exactly this use, it costs no compute on Hobby, and it keeps the stream on the rewrite path. Fallback if the live run shows the transform misbehaves: Routing Middleware (all plans), recorded in the runbook. The gate in Caddy is a first cheap filter; the application's timing-safe check is the real one.

## Verification

**Commands:**
- `node --test scripts/e2e/caddy-origin.e2e.test.mjs scripts/check-sse-rewrite.test.mjs` -- expected: all pass
- `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/check-contract-rules.mjs` -- expected: pass