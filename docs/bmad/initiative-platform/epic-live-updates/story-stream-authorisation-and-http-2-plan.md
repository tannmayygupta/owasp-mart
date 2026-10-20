---
title: 'Stream authorisation and HTTP/2'
type: 'feature'
ticket: '2'
created: '2026-10-19'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/03-origins-and-access.md'
  - '{project-root}/contracts/domain-events/README.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** The live hub of story 7.1 takes its streams from the session, but a recruiter of a company that is pending or suspended still carries that company in the session and would have got its stream; an open dashboard keeps its session alive for ever because looking at a session counts as activity; and nothing proves that the stream runs over HTTP/2 (FR-LIV-03, FR-LIV-05).

**Approach:** `StreamAuthoriser`: own user stream, company stream only for an active recruiter of an active company, admin stream only for an admin session (second factor), re-checked while the stream is open so a logout, revocation, timeout, suspension or removal ends it; `SessionService.resolve(touch=False)` for the stream, its snapshot and the re-check so they are not activity; a stack test that runs the real Caddy image and speaks HTTP/2 to it.

## Boundaries & Constraints

**Decisions (developer):** "continue automatically", branch, pull request and merge per task; no open question blocks this story. Claude's choices, in ADR 0053 (Proposed) for confirmation: the company's standing decides the company stream (fail closed), passive session checks, a 30-second re-check, HTTP/2 through the front rather than a different API server.

**Always:** the streams of a connection come from the session and the company's standing, never from the client; a learner never gets a company stream and nobody but an admin session gets the admin stream; an open connection ends when its streams are no longer exactly what it was opened with; the stream and its snapshot do not count as activity; the HTTP/2 answer carries no connection-specific header and no compression.

**Never:** No HTTP/2 in the API server itself; nothing about Vercel (spike S-14); no ticket route; no browser client (the dashboards').

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Learner, candidate | own session | own user stream only | n/a |
| Recruiter, active company | session with company | own user stream and the company's | n/a |
| Recruiter, pending, rejected or suspended company, or removed | session names a company or none | own user stream only | a failing lookup grants nothing |
| Admin | session with a second factor / without | own and admin streams / own only | n/a |
| While open | logout, revoke, timeout, suspension, removal, disabled account | the connection ends within 30 s | the client reconnects and is refused or re-authorised |
| An event id of someone else's stream | `Last-Event-ID` | a place in time only: the caller's own events after it | n/a |
| Idle owner, dashboard open | stream and snapshot only | the session times out | n/a |
| HTTP/2 through Caddy | one connection, six streams, a call | all work; a seventh stream is 429 | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/live/{authorise,api}.py`, `accounts/{sessions,http}.py` (`resolve(touch=)`, `authenticated_passive`), `main.py` (`live_authoriser`).
- `infra/caddy/Caddyfile.live-h2` (test only), `scripts/e2e/platform-stack.e2e.test.mjs`.
- Tests: `test_live_authorisation.py`, `test_live_api.py`.

## Tasks & Acceptance

**Execution:**
- [x] `StreamAuthoriser` and its use at open and at every re-check.
- [x] Passive session reads for the live routes.
- [x] Authorisation tests with real services, over HTTP with real sessions, and the real-stack tests (isolation, logout, HTTP/2 through Caddy).

**Acceptance Criteria:**
- Given any role, then a user cannot subscribe to another user's or company's stream.
- Given a company that is not active, then its recruiters get no company events.
- Given a logout or a suspension, then the open stream ends.
- Given an idle owner with a dashboard open, then the session still times out.
- Given the real Caddy image, then the stream, a second stream and an ordinary call share one HTTP/2 connection.

## Implementation Notes

- The session names the company of an active membership whatever the company's state (ADR 0049); the authoriser asks for the company's standing, so the first mutation of its test (always grant the company stream) fails eight tests.
- `resolve` counted every look as activity, which the stream's re-check and the browser's automatic reconnect would have used to keep a session alive for ever; found while reading the code for the re-check, tested over HTTP with a mutation.

## Plan Change Log

## Review Triage Log

### 2026-10-19, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The company stream would have been given to the recruiter of a pending or suspended company | high | patch | `StreamAuthoriser` asks for the standing; mutation fails 8 tests |
| 2 | An open stream or a reconnecting browser would have kept an idle session alive for ever | high | patch | `resolve(touch=False)`; the HTTP test fails when the route touches again |
| 3 | A logout reaches an open stream only at the next re-check (up to 30 s) | low | recorded | ADR 0053, deferred work |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
