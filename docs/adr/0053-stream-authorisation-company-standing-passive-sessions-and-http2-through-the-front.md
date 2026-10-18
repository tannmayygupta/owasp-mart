# 0053. Stream authorisation: the company's standing, passive session checks, and HTTP/2 through the front

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome)
- **Date:** 2026-10-19
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-LIV-03, FR-LIV-05, FR-DSH-06, FR-ACC-04, FR-ORG-06, ADR 0049, ADR 0052
- **Handoffs:** H-143

## Context
ADR 0052 chose the streams of a connection from the session. Three things were left. (1) The session carries the company of an *active membership*, whatever state the company is in (ADR 0049, so that a pending company's owner can use their own screens), so a recruiter of a pending, rejected or suspended company would have got the company's live stream. (2) The hub looks at the session every 30 seconds, and `SessionService.resolve` counts as activity, so an open dashboard (or the browser's automatic reconnect after every stream) would keep a session alive for ever and the 30-minute idle timeout (FR-ACC-04) would never fire. (3) FR-LIV-03 wants HTTP/2 so that a stream does not use up one of the browser's six connections; the API server speaks HTTP/1.1 and the front (Vercel, Caddy) is what the browser talks to.

## Options considered
1. **The company stream:** whoever has a company in the session / only an active recruiter of an active company.
2. **Looking at a session while a stream is open:** the ordinary resolve (counts as activity) / a resolve that does not count.
3. **HTTP/2:** make the API speak it (a different server) / rely on the front and prove that the stream passes through it.

## Decision
- **`StreamAuthoriser`** (`live/authorise.py`) is the one place that decides the streams: the person's own user stream; the company stream only when the session is a recruiter's, names a company, and `CompanyService.active_company_of` says that person is an *active* recruiter of an *active* company and that it is the same company (anything else, an error included, grants nothing: fail closed; with no way to ask, no company stream); the admin stream only when the session has the admin role (which an admin session gets only after a second factor). It runs when a connection opens and at every re-check, and an open connection ends when its streams are no longer exactly what it was opened with: logout, revocation, timeout, a suspended or deleted company, a removed or suspended member, a disabled account.
- **Passive sessions:** `SessionService.resolve(token, touch=False)` looks at a session without extending it. The stream, its snapshot and the re-check use it (`authenticated_passive`, `session_still_allowed`), so what a page does by itself never counts as the person being active: a dashboard left open by an idle person still times out after 30 minutes (15 for an admin). Ordinary calls (a click, a form) still extend the session. A consequence the dashboards must know (H-143): a page that only watches the stream will log its owner out after the idle time, as the requirement says.
- **A logout or revoke ends a stream within the re-check interval** (30 s), not at once. The events delivered in that time are the person's own and already authorised when they were appended; a tighter interval costs one session and company lookup per connection per interval.
- **HTTP/2** is the front's: the API sends nothing that HTTP/2 forbids (no `Connection` or `Transfer-Encoding` header, no compression) and a stack test runs the real Caddy image (`infra/caddy/Caddyfile.live-h2`, the `/api/*` block of `infra/deploy/Caddyfile.platform` with `flush_interval -1` and the origin secret, a local certificate) on the compose network and speaks HTTP/2 to it with Node's `http2` client: the protocol negotiated is `h2`, six streams of one user and an ordinary call share one connection, a seventh stream is refused with 429, and an event reaches all six. The per-user cap of six stays: it protects the API, and with HTTP/2 it is no longer what the browser limits.

## Consequences
- A company that is suspended takes its live view away from its recruiters within 30 seconds, and a company that is not yet approved never had one.
- The standing check is a few queries per connection every 30 s; at the 2000-connection cap that is about 70 checks a second per process (placeholders, OI-25).
- HTTP/2 is proven locally with Caddy only. Vercel's leg (spike S-14) and the Hobby plan's behaviour are **not verified**; HTTP/2 between the front and the API is not used.
- `POST /api/v1/live/ticket` is still pending S-14.

## Evidence
- `test_live_authorisation.py` (22 tests with the real session, company and account services: each kind of person gets exactly its streams, the pending, suspended and removed cases, fail closed, an open stream ends on logout, revoke, timeout, suspension, removal and a disabled account, over HTTP a learner, candidate, recruiters of two companies, a recruiter of a pending company and admins with and without a second factor each read only their own streams while events sit in everyone else's, another person's event id is no way into their events; with two on passive sessions, each shown to fail when the live routes touch the session again) and `test_live_api.py`.
- Real stack: a second user never receives the first user's events, with or without their ids; a logout ends an open stream (30 s later); six HTTP/2 streams and a call share one connection through the real Caddy image; see the dev-log.
- The WHATWG and RFC 9113 texts were not re-read for this ADR; HTTP/2 behaviour here is what Node's client and Caddy 2.10 did.
