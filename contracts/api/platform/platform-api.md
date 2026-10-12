# Platform API v0 (IF-1): the browser-facing routes the platform owns

Status: DRAFT 0.1.0 (story P-04, stream P). Source of truth: [`platform.openapi.yaml`](platform.openapi.yaml) (OpenAPI 3.1). This file explains it; where the two differ, the YAML wins and this file is a bug.

Who reads this: the dashboards (stream P, later Sahil's pages), the API routes (P-06 and later), stream L (the lab fragment [IF-2](../lab/lab-api.md) shares the rules below).

## 1. Scope and ownership

This is the **sprint-2 slice**: 25 operations on 21 paths, all under `/api/v1/`. Organisations, assessments, invitations, exports, admin, withdrawal and purge are added later, additively, with their own stories.

| Area | Operations |
|---|---|
| Health | `GET /health` |
| Accounts | `POST /accounts`, `POST /accounts/verify-email`, `POST /accounts/verify-email/resend` |
| Session | `POST /session` (log in), `GET /session`, `DELETE /session`, `POST /session/mfa` |
| Me | `GET` and `PATCH /me`, `POST /me/password`, `POST` and `DELETE /me/mfa`, `POST /me/mfa/confirm` |
| Password reset | `POST /password-reset/request`, `POST /password-reset/confirm` |
| Consent | `GET /consent/notice?attempt_id=`, `POST /consent`, `GET /me/consents` |
| Catalogue | `GET /challenges`, `GET /challenges/{challenge_key}` |
| Attempts | `GET /me/attempts` |
| Live | `GET /live` (SSE, IF-3 events), `GET /live/snapshot`, `POST /live/ticket` (**pending** spike S-14, ADR 0006 plan B) |

Internal routes (`POST /internal/v1/events`, `POST /internal/v1/orch/state`; handoffs H-16, H-17) are not here and never in the browser bundle: they stay in stream L's IF-4 and IF-5 files. The bundler fails when a browser fragment has a path with `/internal/`.

## 2. Rules that hold for every route

These are the rules of the lab fragment (IF-2), so the dashboards meet one behaviour.

- **One origin.** The browser calls the dashboard origin only; the platform forwards `/api/*` to the API **without removing the prefix**, so a FastAPI route is exactly the path in the bundle (P-06 and P-07 change the rewrite of P-01 accordingly).
- **Session.** An authenticated route needs the HttpOnly cookie `__Host-vm_session` (Secure, SameSite=Lax, no Domain). Idle expiry 30 minutes (admin 15), absolute 12 hours; the answer of `GET`/`POST /session` says both times.
- **CSRF.** Every state-changing authenticated call (POST, PATCH, DELETE) sends `X-CSRF-Token`, the signed session-bound token from the session answer (ADR 0019), plus an `Origin` equal to the dashboard origin and, for a body, `Content-Type: application/json`. A **public** state-changing call has no session and no CSRF token; it still needs the Origin check and is rate limited.
- **Cache.** Every answer says `Cache-Control: private, no-store`.
- **Errors.** Every error answer is `application/problem+json`, the closed IF-8 body (`type`, `title`, `status`, `code`, `request_id`, and `field` or `errors` for 422). Codes come from `contracts/errors/error-codes.yaml` (registry 0.2.0 added five for this API: `AUTH-EMAIL-NOT-VERIFIED`, `AUTH-INVALID-CREDENTIALS`, `AUTH-MFA-INVALID`, `AUTH-TOKEN-INVALID`, `REQ-RATE-LIMITED`; 0.3.0 added `AUTH-MFA-STATE` and `ATT-CONSENT-STALE`, the two 409 causes that are not an attempt state). The one exception is the 503 of `GET /health`, which answers `{"status": "degraded"}` for probes.
- **No oracle.** Signup, resend and reset-request answer the same 202 whatever the address is (FR-ACC-08). A login with an unknown email and one with a wrong password answer the same 401.
- **Missing equals not yours.** A resource that does not exist and one that is not the caller's answer the same 404.
- **Rate limits.** A public state-changing route declares 429 (per address and per email); so does every authenticated state-changing route that takes a body, because it checks a secret (password, code) or writes. 429 carries `Retry-After`.
- **Never in an answer:** a flag, a hint text, a digest, a seed, an event key, a password or its hash, a token hash, a stack trace.
- **Time** is UTC, RFC 3339, trailing `Z`, whole seconds. **Ids** are `u-`, `a-`, `i-`, `k-` plus 16 Base32 characters. **Lists of the caller's own records** (`/me/attempts`, `/me/consents`) take `limit` (default 50, maximum 100) and say `has_more`; there is no cursor yet (open point 15). The catalogue has eleven entries and takes no `limit`.

Two answers have more than one cause, and the examples name both: a 401 on `POST /me/password`, `DELETE /me/mfa` and `POST /me/mfa/confirm` is either no session (`AUTH-SESSION-REQUIRED`) or a wrong password or code (`AUTH-INVALID-CREDENTIALS`, `AUTH-MFA-INVALID`).

## 3. Behaviour of the routes worth knowing before you build against them

- **Log in** answers `200` with either a `Session` (`status: authenticated`, cookie set, `csrf_token` to keep in memory) or `MfaRequired` (`status: mfa_required`, a short-lived `mfa_ticket`, no cookie); the browser then calls `POST /session/mfa`. `403 AUTH-EMAIL-NOT-VERIFIED` is sent only after the password was right.
- **Live.** Open `GET /live/snapshot` first, then `GET /live`. The stream carries IF-3 events; the audience comes from the session, never from the client. `Last-Event-ID` resumes; an unknown or too old id gets one `stream.resync` and the stream ends, and the client reloads the snapshot and reconnects. Heartbeat comment about every 15 seconds. `POST /live/ticket` exists only if the Vercel rewrite buffers the stream; if plan A holds it is removed.
- **Consent.** `GET /consent/notice` gives the version, the text and its hash; `POST /consent` repeats the version and hash, and a mismatch is 409 (stale screen). `granted` moves the attempt to `ready`; `declined` ends it. Records are append-only.
- **Catalogue.** Challenge keys are `C01`..`C11` here and in IF-2/IF-3; the catalogue file (IF-7) writes `c01`..`c11` and the API maps between them.

## 4. Bundle, mock, generated code

| What | Where | Command |
|---|---|---|
| Bundle of IF-1 and IF-2 | `contracts/api/bundle/openapi.json` (+ `bundle-report.json`) | `pnpm run contracts:bundle`, proof `pnpm run contracts:bundle:check` |
| Mock | `contracts/mocks/platform-mock/server.mjs` | `pnpm run mock:platform -- --port 4010 --origin http://localhost:3000` |
| TypeScript client | `packages/ts-client` (`createApiClient`, `isProblem`, types in `src/api.d.ts`) | `pnpm run api:generate` |
| Python models | `packages/py-models/src/vulnmart_models/api.py` (Pydantic v2) | `pnpm run api:generate` |
| All checks | | `pnpm run api:check` (in CI) |

The bundle keeps one definition of every shared component (the platform's, the IF-8 `Problem` first). A lab component that differs from a platform component of the same name is kept as `Lab<Name>` and listed in the report: stream L's IF-2 still has its own error bodies and lowercase codes (see `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`).

**The mock** answers the first declared example of every operation with its declared status. `Prefer: code=NNN` picks another declared answer, `Prefer: example=NAME` a named example. Protected routes need the cookie `__Host-vm_session` with any non-empty value (the mock does not tell users apart; a login answer sets `FAKE-SESSION-ADA`); state-changing ones also need a non-empty `X-CSRF-Token` and the `Origin`. Lab routes are forwarded to the fake lab (started as a child process unless `--no-lab` or `--lab-url`). `Prefer: code=NNN` answers at once: the cookie, CSRF, Origin and body checks are skipped for it. The Origin of every POST, PATCH and DELETE must equal `--origin` (default `https://dashboard.example.invalid`): a dashboard on `http://localhost:3000` starts the mock with `--origin http://localhost:3000`. The session cookie is `Secure` and `__Host-` prefixed as in the contract; Chrome and Firefox keep it on `localhost`, Safari does not. The mock needs no service, only `ajv`, `ajv-formats` and `js-yaml` from the pnpm workspace. It is not Prism (open point 3).

**The client** is `openapi-fetch` over types from `openapi-typescript`:

```ts
import { createApiClient } from '@vulnmart/ts-client';
const api = createApiClient({ baseUrl: '', csrfToken: () => session?.csrf_token });
const { data, error } = await api.POST('/api/v1/session', { body: { email, password } });
```

It sends cookies (`credentials: 'include'`) and adds `X-CSRF-Token` to every unsafe request when `csrfToken()` gives a token. `isProblem` recognises the IF-8 body of the platform routes only: the 18 lab operations still answer IF-2's own error body (`LabProblem`, lowercase codes) until story 1.12 aligns it. In the Python models an e-mail address is a plain `str` (the e-mail library refuses `.test` and `.local`, which dev and test mail uses) and "an object with at least one member" is not expressed; the API validates both against the bundle.

## 5. Open points (to confirm)

Each row is a proposal made while writing the contract; none is decided unless it says so. The routes that depend on an open question (OI-xx) are marked pending in the YAML with both outcomes.

| # | Proposal | Why it is open |
|---|---|---|
| 1 | Scope of this draft is the sprint-2 slice above | Decided by the developer 2026-10-11 |
| 2 | The bundler is a Node script (js-yaml); identical shared components once, the platform's `Problem` is authoritative, differing lab ones under the `Lab` prefix | Decided by the developer 2026-10-11 (handoff H-84) |
| 3 | The mock is a small Node server that reads the bundle, not Prism (Prism 5.16 needs Node 24.18 or newer) | Decided 2026-10-11; architecture 07 was updated with the tool names |
| 4 | Generated code: `openapi-typescript` 7.13.0 with `openapi-fetch` 0.17.0, and `datamodel-code-generator` 0.83.0 (Pydantic v2), committed and checked for freshness | Decided 2026-10-11; architecture 07 says "tool names confirmed" |
| 5 | The `/api` prefix is kept on the way to FastAPI (no stripping) | Assumption: P-01's rewrite strips it today and changes in P-06 and P-07 |
| 6 | Password: 12 to 128 characters, refused when in a breach list (422) | FR-ACC-08 leaves the quality rules to be tuned |
| 7 | Link and reset tokens live 24 hours, single use | Placeholder |
| 8 | Sessions: idle 30 minutes (admin 15), absolute 12 hours | FR-ACC-04; the lab fragment uses the same |
| 9 | Signup may need a CAPTCHA token: optional field, marked pending | OI-29 is OPEN |
| 10 | What a consent record keeps, and for how long | OI-37 is OPEN; the notice text is a placeholder until legal review (OI-33) |
| 11 | `POST /live/ticket` stays in the draft | Spike S-14 decides (ADR 0006 plan A or B) |
| 12 | Catalogue key form `C03` in the API, `c03` in IF-7 | Sahil to confirm the mapping or move IF-7 to `C03` |
| 13 | `GET /me/attempts` lists practice and assessment attempts of the caller only | Company-side lists come with the organisation routes |
| 14 | An email change and an account deletion are not in this slice | An email change needs its own verification step; deletion belongs to the privacy stories (FR-PRV, P-25) |
| 15 | No cursor on `/me/attempts` and `/me/consents`: `has_more` tells a caller that more exist, and the first `limit` (at most 100) are all it can read | Accepted for the sprint-2 volumes (developer, 2026-10-11); a cursor is added additively with the dashboards story that needs it. `LiveSnapshot` arrays are likewise unbounded |
| 16 | An email address is compared case-insensitively after trimming surrounding spaces, and one address is one account | Not stated by the requirements; the no-oracle answers depend on it |
| 17 | `GET /session` and `GET /live` do not extend the idle timer; any other authenticated call does | A proposal (not in the YAML): a dashboard that polls must not keep a session alive for ever |
| 18 | `DELETE /session` with an expired or missing session answers 401 and still sends `Set-Cookie` with `Max-Age=0`, so a stale `__Host-` cookie is removed | A proposal, not in the YAML yet: the 401 of `deleteSession` would carry `Set-Cookie` (today only its 204 does) |
| 19 | `DELETE /me/mfa` takes the password in a request body. A client or proxy that drops bodies on DELETE cannot use it | Alternative: `POST /me/mfa/disable`; kept as DELETE because the operation is a deletion |
| 20 | Rate limits (429) on every authenticated state-changing route with a body, not only on the public ones | Decided by the developer 2026-10-11 (code review of P-04); the numbers are open |
