# Stream authorisation and HTTP/2 (P-23, story 7.2)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-7 / see the pull request |
| Status | Built and tested on the local stack. Not built: a Vercel path check and the ticket route (spike S-14), HTTP/2 between the front and the API, any browser client (the dashboards'). Story 7.2 is `built`, awaiting the developer's confirmation |
| Report tag | stream authorisation, company scoping, session lifecycle, HTTP/2, BMAD cycle |

## Requirements covered
FR-LIV-05 (each stream carries only what the signed-in user may see; the rest of it, the session part, was built in P-22) and FR-LIV-03 (HTTP/2, spike-dependent: proven locally through the real Caddy image). Related: FR-DSH-06, FR-ACC-04, ADR 0053 (new), ADR 0052 and 0049, handoff H-143 (new). No open question blocks the story.

## Summary (plain language, 3-5 lines)
The live stream now gives each person exactly their own events: a learner or candidate only their own, a recruiter also their company's but only while their company is active, an admin the admin stream only with a second factor. An open stream ends when the person logs out, is revoked, times out, or their company is suspended or they are removed. The stream and its snapshot no longer count as the person being active, so a dashboard left open by an idle person still times out. A real Caddy in front of the API carries six streams and an ordinary call over one HTTP/2 connection.

## Why
The hub of P-22 took its streams from the session, but the session carries the company of an active membership whatever state the company is in, so a recruiter of a pending or suspended company would have received its live events; and looking at a session counted as activity, so an open page kept it alive for ever.

## What was built
- `live/authorise.py`: `StreamAuthoriser` (own stream; company stream only for an active recruiter of an active company, fail closed; admin stream only for an admin session). `live/api.py`: the routes use it at open and `session_still_allowed` at every re-check.
- `accounts/sessions.py`: `resolve(token, touch=False)`; `accounts/http.py`: `authenticated_passive`; the stream, the snapshot and the re-check use them.
- `main.py`: `live_authoriser` (defaults to `CompanyService.active_company_of`). `infra/caddy/Caddyfile.live-h2` (test only). ADR 0053 (Proposed); handoff H-143; the plan of story 7.2.

## How it works
A connection asks the authoriser for its streams when it opens and again every 30 s, and ends when they are no longer exactly what it was opened with or the session is gone; the re-check looks at the session without extending it. For a recruiter the authoriser asks the company service whether the person is an active recruiter of an active company and that it is the company of the session; anything else, a failing lookup included, grants no company stream. For HTTP/2 the stack test starts the real Caddy image on the compose network with a local certificate and the `/api/*` block of the production Caddyfile, and speaks HTTP/2 to it with Node's client.

## Files changed
- New: `live/authorise.py`, `infra/caddy/Caddyfile.live-h2`, `test_live_authorisation.py`, `docs/adr/0053-*.md`, the plan of story 7.2, `docs/assets/p-23-stream-authorisation/`.
- Changed: `live/api.py`, `accounts/{sessions,http}.py`, `main.py`, `test_live_api.py` (the role-to-stream tests moved to the new file), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0053 (Proposed) for confirmation: the company's standing decides the company stream (fail closed), passive session checks, a 30-second re-check, HTTP/2 through the front rather than a different API server.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-23-stream-authorisation/`.
- New: `test_live_authorisation.py` 22 (real session, company and account services on SQLite: the streams of a learner, candidate, recruiters of two companies, a colleague, a recruiter of a pending, suspended or removed standing, admins with and without a second factor; fail closed on no lookup, a failing lookup and a company that is not the session's; an open stream ends on logout, revoke, timeout, suspension, removal, deletion of the company and a disabled account; over HTTP each kind of person reads exactly their own streams while events sit in all the others, another person's event id is only a place in time, a forged or missing cookie is 401; two tests that the stream and snapshot do not extend an idle session). The eight role-to-stream tests that were in `test_live_api.py` moved there, so `test_live_api.py` has 16. Mutation checks done by hand: always granting the company stream fails 8 tests; letting the live route touch the session again fails the HTTP idle test.
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2505 passed, 0 failed, 1 skipped** (472 s; the one skip is a Windows file-mode check in the lab tests).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **29 of 29** on the final code (`platform-stack-e2e-2026-10-19.txt`; the run before the passive-read change, also 29 of 29, is kept). The new tests: two users, each receives only their own event; Bob's event id given by Alice is no way into Bob's events; no cookie or a forged one is 401; after a logout the open stream ended 29987 ms later (the 30 s re-check), without a resync, and the old cookie is 401; over HTTP/2 through the real Caddy image (`alpnProtocol` `h2`), six streams of one user and a snapshot call share one connection (the call took 54 ms while six streams were open), a seventh stream is 429 with `Retry-After: 5`, no `Connection`, `Transfer-Encoding` or `Content-Encoding` header on the stream, and one event row reached all six streams in 277 ms.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable. The text-hygiene, progress-page, dev and demo script tests: 70 of 70. The web unit tests: 9 of 9.
- NOT run: a browser, the Vercel path, HTTP/2 to the API itself, anything on the VMs, CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-23-stream-authorisation/`: the test outputs.

## Problems met and how they were fixed
- Reading the code for the re-check showed that `resolve` counts as activity, so an open stream (and the browser's automatic reconnect every 15 minutes) would have kept a session alive for ever: `resolve(touch=False)` and `authenticated_passive`, tested over HTTP and by mutation.
- The session names the company of an active membership whatever its state, so the company stream needed the company's standing (above).
- In the P-22 and P-21 runs the contract check `table-owners` reported that it could not run (its uv build step) when started right after the tests in the same shell; it passed when run by itself, and here I ran it without the test `PYTHONPATH` set in the shell and it passed; I did not prove that the variable is the cause.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: nobody receives a stream they are not entitled to, a recruiter of an inactive company gets no company events, a lookup that fails grants nothing, an open stream ends when its entitlement does, a stream cannot keep an idle session alive, and another person's event id is only a place in time.

## Limitations and follow-ups
- The Vercel leg and the Hobby plan (spike S-14) are not verified; HTTP/2 between the front and the API is not used. A logout reaches an open stream within 30 s, not at once. Dashboards that only watch the stream log their owner out after the idle time (H-143).
- The caps and intervals stay placeholders (OI-25). ADRs 0040 to 0053 are Proposed.
- Remind: Excel, P-23 Done = Yes; confirm story 7.2 so it can move to `done`.
