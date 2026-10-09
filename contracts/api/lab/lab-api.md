# Lab API v0 (IF-2): the browser-facing routes the lab owns

- **Version:** 0.1.0 (draft, 0.x until the tag `contracts-v1.0.0` in story L-09). See [../../CHANGELOG.md](../../CHANGELOG.md).
- **Owner:** stream L (Tanmay). Consumer: the dashboards (stream P, Akshay, story P-04). Under D-37 the review by Akshay is optional during initial development; the proposals below are for him to confirm in the team chat.
- **Source:** `docs/architecture/07-repo-and-workstreams.md` sections 3.1, 3.4 and 3.5 (the catalogue row of IF-2, composition, the ports; the older citation "arch 07 s3.3" for IF-2 is stale), `03-origins-and-access.md` (cookies, CSRF, the one-time ticket), `04-data-and-state.md` sections 2.5, 2.6, 10 and 11 (tables, state machines, flag verification), `05-key-flows.md`, and the PRD requirements FR-SES, FR-INS, FR-FLG, FR-HNT, FR-ACH, FR-SCR, FR-DSH, FR-DET.
- **Machine-checkable part:** [lab.openapi.yaml](lab.openapi.yaml) (OpenAPI 3.1), examples in `examples/`. Check it: `pnpm run contracts:check` (the last part of that command) or `uv run --package vulnmart-api python scripts/check_lab_contract.py`.
- **Mock:** `contracts/mocks/fake-lab/server.mjs` (Node, no dependency, not Prism).

Plain terms: this is the list of calls the dashboards make to start and use an instance, paste flags, take hints and read scores, evidence and reports. The architecture named the contract (IF-2) but fixed no paths; this file and the OpenAPI file do. Every value the architecture does not fix is a proposal, listed in the table at the end ("Open points (to confirm)"). The file is a **fragment**: the platform routes (IF-1) are written separately by stream P, and a bundle script (P-04's) will merge the two.

## 1. Scope and ownership

A route is **lab-owned** when it reads or changes the tables the lab owns (attempts runtime, instances, milestones, flag submissions, hints, evidence, integrity flags, scores; architecture 07 section 5). Everything else is platform-owned.

| Operation | Method and path | Success | Meaning |
|---|---|---|---|
| `requestInstance` | `POST /api/v1/instances` | 202 | Request a learner instance |
| `getInstance` | `GET /api/v1/instances/{instance_id}` | 200 | State, access, health |
| `openInstance` | `POST /api/v1/instances/{instance_id}/open` | 200 | One-time URL for the new tab |
| `resetInstance` | `POST /api/v1/instances/{instance_id}/reset` | 202 | New epoch, new flags |
| `stopInstance` | `POST /api/v1/instances/{instance_id}/stop` | 202 or 200 | Stop and destroy |
| `getAttempt` | `GET /api/v1/attempts/{attempt_id}` | 200 | State and clock |
| `startAttempt` | `POST /api/v1/attempts/{attempt_id}/start` | 200 | Start the clock (**pending OI-22**) |
| `submitAttempt` | `POST /api/v1/attempts/{attempt_id}/submit` | 200 | Manual submit after confirmation |
| `submitFlag` | `POST /api/v1/attempts/{attempt_id}/flags` | 200 | Paste a flag |
| `getScore` | `GET /api/v1/attempts/{attempt_id}/score` | 200 | Score snapshot |
| `listChallenges` | `GET /api/v1/attempts/{attempt_id}/challenges` | 200 | Progress per challenge |
| `listHints` | `GET .../challenges/{challenge_key}/hints` | 200 | Three hint levels |
| `unlockHint` | `POST .../challenges/{challenge_key}/hints/{level}/unlock` | 200 | Unlock one level |
| `listEvidence` | `GET /api/v1/attempts/{attempt_id}/evidence` | 200 | Captured requests (redacted) |
| `listIntegrityFlags` | `GET /api/v1/attempts/{attempt_id}/integrity-flags` | 200 | Integrity signals |
| `decideIntegrityFlag` | `POST .../integrity-flags/{integrity_flag_id}/decision` | 200 | Review decision |
| `getReport` | `GET /api/v1/attempts/{attempt_id}/report` | 200 | Per-candidate report |
| `getTimeline` | `GET /api/v1/attempts/{attempt_id}/timeline` | 200 | What happened, oldest first |

Who may read what (the mock enforces this; a failure is always the same 404):

| Route group | Owner of the attempt | Recruiter of the owning company (candidate attempt) | Anyone else |
|---|---|---|---|
| Instances (all five) | yes | no | 404 |
| `getAttempt`, `getScore`, `listChallenges`, `getTimeline` | yes | yes | 404 |
| Start, submit, flags, hints | yes | no | 404 |
| Evidence, integrity flags, report | learner attempt: yes; candidate attempt: **OI-15** (the mock says no) | yes | 404 |
| Decision on an integrity flag | no: answered 404 like anyone else (the contract declares no 403 for it; the owner may read but not decide) | yes (**OI-38**) | 404 |

A recruiter never sees a learner practice attempt (privacy wall, FR-DSH-06): such an attempt has no company.

### What is not here (platform-owned, listed as handoff rows for Akshay)

Login, logout, session, current user, organizations, assessments, invitations, consent, **create-attempt-from-consent**, cancel, withdraw, purge, exports (OI-27), admin routes, the challenge catalogue (IF-7 content: titles, tags, difficulty), the live stream and the live ticket, and the list of a user's attempts. Their paths belong to IF-1.

## 2. Values shared with IF-5

The browser sees exactly the values of the orchestrator contract (handoff H-78); a check fails if they differ.

- **Instance state** (10): `requested`, `provisioning`, `starting`, `ready`, `active`, `idle`, `resetting`, `stopping`, `destroyed`, `failed`.
- **Access** (3): `open`, `frozen`, `closed`.
- **Health** (3): `unknown`, `healthy`, `unhealthy`.
- **Attempt state** (10, architecture 04 section 10.1, no `paused`): `invited`, `consent`, `ready`, `running`, `submitted`, `reported`, `withdrawn`, `expired`, `cancelled`, `deleted`.
- **Flag result** (5): `correct`, `wrong`, `decoy`, `other_instance`, `stale_epoch`. **Credit**: `credited`, `held`, `none`.
- **Milestone**: `none`, `M1`, `M2`, `M3`. **Integrity type**: `decoy`, `sharing`, `timing`, `activity`, `similarity`. **Integrity status**: `open`, `accepted`, `rejected`.

## 3. Authentication and cross-cutting rules

1. **Session.** Every route needs the `HttpOnly` cookie `__Host-vm_session` (architecture 03 section 1.4). No cookie or an unknown one: 401 `AUTH-SESSION-REQUIRED`.
2. **State-changing calls (POST)** also need: the header `X-CSRF-Token` carrying the CSRF token, a signed, session-bound value (an HMAC of the session id with a server secret, decided 2026-10-09, issued and checked by the platform, Akshay, P-05; ADR 0019, M2), checked together with the Origin check; `Sec-Fetch-Site` is also checked where the browser sends it. **The mock keeps a simple equality check** of the header with the cookie `__Host-vm_csrf` and does not sign or check `Sec-Fetch-Site`; an `Origin` header equal to the dashboard origin; a JSON content type when there is a body. A missing or wrong header: 403 `AUTH-CSRF-FAILED`; a wrong or missing Origin: 403 `AUTH-ORIGIN-FORBIDDEN`. Nothing is changed. The 403 comes before any lookup.
3. **JSON only.** A body that is not `application/json`: 415 `REQ-UNSUPPORTED-MEDIA-TYPE`. Over 64 KiB: 413 `REQ-TOO-LARGE`; the service reads and discards the rest of the body up to a limit (1 MiB in the mock) so the client can read the 413, then closes the connection; a client that keeps sending far more may see a reset instead. A POST that takes no body (open, stop, start, unlock) refuses one with 422.
4. **No caching.** Every answer, errors included, carries `Cache-Control: private, no-store` (architecture 03 section 1.3: the proxy honours upstream cache headers).
5. **Errors** are `application/problem+json` (problem-details style: the members are our own `code`, `message`, `request_id` and `field`, not the RFC 9457 members `type`, `title`, `status`, `detail`, `instance`; see ADR 0019, mismatch M1, awaiting the developer) with `code`, `message`, `request_id` and, for 422, `field` (a JSON Pointer, empty for the whole body). The message never repeats a submitted value. No stack trace.
6. **Missing and not yours are the same.** An unknown id, a malformed id and another user's id all give the same 404 (`ATT-NOT-FOUND` for attempt routes, `INST-NOT-FOUND` for instance routes). The lookup comes before the body check, so a body error never reveals that an id exists.
7. **Order of checks** (mock and proposal): body size first (an oversize body is refused with 413 before anything else is looked at, as in IF-5; a client that sends far more than the limit may see a reset before it reads the 413; a body only a little over the limit always gets the 413), then route (404 or 405 with `Allow`), session (401), Origin and CSRF (403), content type (415), lookup and ownership (404), body shape (422), state (409), rate limit and the rest (429). A path with malformed percent-encoding is the same 404 as an unknown path.
8. **Never in an answer:** a flag, a decoy, a digest, a seed, an event key, an owner hash, an orchestrator address, a host id, a host name or a stack trace. The OpenAPI answer schemas are closed (`additionalProperties: false`), and the check fails when a GET schema or a valid answer example holds one of those names. The submitted flag text is never echoed and never stored (only the result and the challenge, FR-FLG-05).
9. **Unknown path or method:** 404 `REQ-ROUTE-UNKNOWN`, or 405 `REQ-METHOD-NOT-ALLOWED` with an `Allow` header.

## 4. Behaviour of the routes

- **Request instance.** Body `{"kind": "learner"}`. 202 with state `requested`; it advances on its own to `ready` (poll `getInstance` or use the live stream). A second request while the user holds an instance: 409 `INST-QUOTA-REACHED` (numbers are OI-21). Candidate instances are created by the platform, not here.
- **Open.** In state `ready`, `active` or `idle` with access `open`: 200 with `{url, expires_at}`; the URL is `https://<instance host>/_vm/enter?t=<ticket>`, single use, about 60 seconds (architecture 03 section 3). Otherwise 409 `INST-NOT-READY`.
- **Reset.** Body `{"confirm": true}`. From `ready`, `active` or `idle`: 202, epoch plus one, state `resetting`. Any other state, an instance whose access is frozen, or an attempt that is not running (for example after submit): 409 `INST-INVALID-STATE`. Milestones already earned stay (FR-SES-09). The reset limit per template is OI-25.
- **Stop.** 202 for a new stop, 200 when already `stopping` or `destroyed`; 409 `INST-INVALID-STATE` when the instance is frozen or its attempt is not running. The freeze after submit is never undone by a timer step.
- **Start (pending OI-22).** From `ready` to `running`; the server sets `started_at` and `deadline_at`. Other states: 409 `ATT-INVALID-STATE`.
- **Submit.** Body `{"confirm": true}`. From `running` to `submitted`; the instance is frozen for 15 minutes, then destroyed (FR-SES-05). Other states: 409 `ATT-INVALID-STATE`.
- **Flag submit.** Body `{"challenge_key", "flag"}` (flag is any text of 1 to 200 characters; the flag format is a placeholder, FR-FLG-02). 200 with `result` and `credit`. Only while `running`, else 409. After 5 wrong submissions for one challenge within 10 minutes the next one is 429 `ATT-FLAG-RATE-LIMITED` with `Retry-After` (seconds), even for a correct value (FR-ACH-01; the hard cap of 30 per challenge per assessment is not modelled, OI-25). A `decoy` or `other_instance` result also creates an integrity flag for a human; neither changes points (FR-SCR-05). A correct value for a challenge that is already credited, or already held with an open flag, gives the same answer again (200, same `credit`) and records nothing new (no second milestone, integrity flag or timeline row). This check comes before the wrong-flag rate limit, so such a repeat is 200 even when the limit for the challenge is reached.
- **Hints.** With hints off (candidate default, FR-HNT-02) both hint routes answer 404 `ATT-HINTS-DISABLED`; an unknown challenge or level is 404 `ATT-CHALLENGE-NOT-FOUND`. The text of a level is null until unlocked; repeating an unlock is 200 and costs nothing more. Levels unlock in order: level 2 needs level 1, level 3 needs levels 1 and 2; an early level is 409 `ATT-INVALID-STATE` with `field` `/level`, and nothing is unlocked. The order check comes after the hints-off 404, the unknown challenge or level 404 and the not-running 409, and only for a level that is not yet unlocked (repeating an unlocked level is still 200). `cost_pct` is 0 for a learner and a placeholder 10, 20, 30 for a candidate. A hint never reveals a flag.
- **Score, challenges, report.** Computed on the server from milestones, hints and decisions (FR-SCR-09); a held capture is not counted until decided (FR-SCR-10). The report carries estimates (`active_seconds`, `technique_label`) that may be null.
- **Integrity decision.** Body `{"decision": "accept"|"reject", "note"}`. One decision per flag, else 409. Accepting a held capture credits it; rejecting keeps it out. A challenge stays held until no held flag of it is open. Never an automatic fail (FR-ACH-06).
- **Timeline.** Oldest first; `cursor` and `limit` (1 to 200, default 50); `next_cursor` is null on the last page. The cursor is opaque to clients; the mock writes a plain decimal offset in base64url and refuses anything else (422, `field` `/cursor`): the decoded value must be a canonical decimal of at most 9 digits (no sign, space, exponent, hex or leading zero), in the canonical base64url form. A cursor past the end answers an empty page with `next_cursor` null. New rows are added at the end, so a page never repeats or skips a row that existed when the first page was read.
- **Query parameters.** The only query parameters of the contract are `cursor` and `limit` on the timeline. A GET with any other parameter, or one given more than once, is 422 `REQ-VALIDATION` with `field` (empty when the name is not plain text); the lookup (404) comes first.

## 5. Error codes (placeholders until IF-8)

| Status | Code | Where |
|---|---|---|
| 401 | `AUTH-SESSION-REQUIRED` | any route |
| 403 | `AUTH-CSRF-FAILED`, `AUTH-ORIGIN-FORBIDDEN` | any POST |
| 404 | `ATT-NOT-FOUND`, `INST-NOT-FOUND` | missing or not yours |
| 404 | `ATT-HINTS-DISABLED`, `ATT-CHALLENGE-NOT-FOUND` | hints |
| 404 | `REQ-ROUTE-UNKNOWN` | unknown path |
| 405 | `REQ-METHOD-NOT-ALLOWED` | with `Allow` |
| 409 | `ATT-INVALID-STATE`, `INST-INVALID-STATE`, `INST-NOT-READY`, `INST-QUOTA-REACHED` | state rules |
| 413 | `REQ-TOO-LARGE` | body over 64 KiB |
| 415 | `REQ-UNSUPPORTED-MEDIA-TYPE` | not JSON |
| 422 | `REQ-VALIDATION` | with `field` |
| 429 | `ATT-FLAG-RATE-LIMITED` | with `Retry-After` |
| (in `error_code` of a failed instance) | `INST-*`, for example `INST-HEALTH-TIMEOUT` | H-02 |

`ORCH-*` codes never reach the browser. The registry (IF-8, story P-02) will fix the final names; renaming is a breaking change before the tag (handoff H-81).

## 6. Mock (`contracts/mocks/fake-lab/`)

A Node service with no dependency that answers every operation (`node contracts/mocks/fake-lab/server.mjs --port 0`; first output line `{"listening":true,"port":N}`; options `--origin`, `--step-delay-ms`). Fake sessions, ids and the four fake test flags are listed at the top of `server.mjs`. It keeps a small state in memory; restart it to reset. It is **not** the real API: it builds nothing and stores no submitted text. The mock rule that a correct flag for C11 in a candidate attempt is held is a test aid, not part of the contract.

## Open points (to confirm)

Each row is a proposal made while writing the contract. None is decided; Akshay confirms in the team chat (D-37: optional during initial development). Rows 1 to 3 were confirmed by the developer on 2026-10-09 for this draft.

| # | Proposal | Why it is open |
|---|---|---|
| 1 | Every route is under `/api/v1/` (the dashboard origin forwards `/api/*`, so the lab and platform fragments share one prefix) | Architecture 03 shows `/api/...` without a version; the examples in 04 and 05 omit the prefix |
| 2 | The mock is a dependency-free Node fake, not Prism | Architecture 07 section 3.1 says Prism, marked UNVERIFIED (ADR 0012 asks for confirmation) |
| 3 | Scope is the lab-owned routes only; the attempt start route is included and marked pending OI-22 | Docs disagree on who owns hints, reports and attempt routes |
| 4 | CSRF header name `X-CSRF-Token`. Decided 2026-10-09 (ADR 0019, M2): the value is a signed, session-bound token (HMAC of the session id with a server secret) checked with the Origin check, and `Sec-Fetch-Site` where the browser sends it; the platform implements it (P-05). The mock only compares the header with the cookie `__Host-vm_csrf` | Architecture 03 names the cookie, not the header |
| 5 | Origin must equal the dashboard origin exactly; a missing Origin on a POST is refused | Architecture 03 says "an Origin that equals DASHBOARD_ORIGIN" |
| 6 | Time values are UTC, RFC 3339, trailing `Z`, whole seconds (the same as IF-5) | Not fixed for the browser API |
| 7 | Id shapes: instance `i-` + 16 Base32 (IF-5); attempt `a-`, integrity flag `g-`, evidence `e-`, each + 16 Base32 | Architecture 04 says `id` only |
| 8 | Pagination: `cursor` and `limit` on the timeline only (default 50, maximum 200); other lists are bounded (11 challenges, 3 hints, 100 evidence entries, 100 integrity flags) | No paging rule exists yet; IF-1 may choose another |
| 9 | No idempotency key: a repeated reset, stop or decision is made safe by the state rules (409, or 200 for stop). An `Idempotency-Key` header for `requestInstance` is the alternative | The architecture is silent; the platform worker side (H-12) is idempotent |
| 10 | Error codes `AUTH-*`, `ATT-*`, `INST-*`, `REQ-*` as in section 5, with these statuses | Registry (IF-8, P-02) not merged |
| 11 | `requestInstance` takes `{"kind": "learner"}` and binds or creates the learner's practice attempt; the lab never creates a candidate attempt (that is create-attempt-from-consent, platform-owned) | Architecture 05 shows `kind learner` only; where the practice attempt is created is not written |
| 12 | One instance per learner (409 `INST-QUOTA-REACHED`); per-user, per-company and global numbers are OI-21 | OI-21 is OPEN: both a queue and a refusal are possible (FR-INS-06) |
| 13 | `startAttempt` exists and starts the clock (outcome A of OI-22). If the clock starts when the instance becomes ready (outcome B), the route is removed and `started_at` is set by the server | OI-22 is OPEN; this route is pending it |
| 14 | Whether a short write-up per solved challenge is required (OI-14): no route here; outcome A (optional write-up) adds one POST, outcome B (none) adds nothing | OI-14 is OPEN |
| 15 | Whether a candidate sees their own score, evidence and report, and when (OI-15): the mock lets a candidate owner read attempt, score, challenges and timeline, and refuses evidence, integrity flags and report; outcome B (after submit, or after the recruiter closes) opens more reads | OI-15 is OPEN |
| 16 | Idle candidate instance stopped and restored inside the window (OI-23): no route and no new state; outcome A needs a resume route and an `idle` meaning, outcome B changes nothing | OI-23 is OPEN |
| 17 | A failed instance shows `state: failed` and an `INST-*` `error_code`; whether it retries and how many times (OI-24) is the orchestrator's; the browser only sees `provisioning` again | OI-24 is OPEN |
| 18 | Ranking aid and private cohort board (OI-26): no route here; outcome A adds a recruiter list route in IF-1, outcome B adds nothing | OI-26 is OPEN |
| 19 | Who may decide an integrity flag or a held capture (OI-38): the mock allows a recruiter of the owning company only; outcome B adds an Admin | OI-38 is OPEN |
| 20 | Numbers of OI-25 (reset limit 3, wrong-flag limit 5 per 10 minutes, hard cap 30, 60-second grace, warnings at 15 and 5 minutes): the 5 per 10 minutes is modelled in the mock; the others are not and need no change of the paths | OI-25 asks to confirm the research numbers |
| 21 | Hints on or off for an attempt is a property of the attempt (`hints_enabled`), set by the platform from the assessment | Where the setting lives is not written |
| 22 | The attempt answer has `server_time` so the dashboard can correct its cosmetic countdown (FR-SES-02) | Not in the architecture |
| 23 | `flag` submitted without a named challenge (architecture 04 section 11.5 allows "tries all 11") is not allowed here: `challenge_key` is required, because the rate limit is per challenge | Two documents differ; the alternative makes the limit per attempt |
| 24 | The flag text length limit is 200 characters and no format is enforced at the edge (the format is a placeholder, FR-FLG-02); any text is `wrong` if it matches nothing | A format check would reveal the format and block a changed one |
| 25 | Retry-After is a whole number of seconds; the value for the flag limit is the time until the oldest of the five wrong submissions leaves the window | FR-ACH-01 says "a 10-minute lock" |
| 26 | The live stream updates the same state these routes return (instance state, milestones); the stream and its ticket are IF-1 or IF-3, not here | Stream routes are platform-owned |
| 27 | Evidence entries carry method, path and a redacted body only (no headers or cookies); the platform redacts before storage (FR-DET-03) | The shape of "the capturing request" is not written |
| 28 | The evidence `path` may carry tokens or other secrets in a query string; the redaction rule for the path (strip the query, redact known parameter names, or keep it) is undecided. Today only the body is redacted (FR-DET-03) | The architecture redacts `Authorization`, cookies and password fields, not the path |
| 29 | Rate limits exist only for wrong flag submissions. No limit or 429 is declared for instance request, hint unlock, integrity decision or reset (the reset limit per template is OI-25), and a double click on instance request is only stopped by the quota rule (409) | FR-ACH-01 limits flags only; a general per-user limit is not written |
| 30 | A `decoy`, `other_instance` or `stale_epoch` result does not count toward the wrong-flag limit; only `wrong` does. Counting them would punish a sharing signal twice; not counting them lets a sharing candidate probe without limit | FR-ACH-01 says "wrong submissions" without saying which results |
| 31 | When one of several open held flags on a challenge is accepted: are solved and held both true? The mock credits the challenge (solved) and keeps held while another held flag is open. Proposal: accepting any flag credits the challenge and resolves the held state; rejecting keeps it held until no held flag is open | Belongs to OI-38 (who decides, and what a decision does); the text says only 'held until no held flag is open' |
