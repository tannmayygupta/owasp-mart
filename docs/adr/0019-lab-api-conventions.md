# 0019. Lab API conventions: route prefix, Node mock, scope

- **Status:** Proposed (the decisions of the developer are recorded as D-39; the cross-cutting rules still await Akshay). Sources read on 2026-10-09 (story 1.11). Two mismatches between the contract text and the sources were decided by the developer on 2026-10-09: M1 (adopt RFC 9457; the change is story 1.12, not made yet) and M2 (signed, session-bound CSRF token; text updated now, implementation is Akshay's in P-05). Handoffs H-90 and H-91 tell Akshay; the ADR may stay Proposed until he has been told.
- **Date:** 2026-10-09
- **Deciders:** Tanmay (stream L, contract owner). Akshay (stream P, consumer) to confirm the open points; review is optional (D-37).
- **Requirements:** IF-2, FR-SES, FR-INS, FR-FLG, FR-HNT, FR-ACH, FR-SCR, FR-DSH, FR-DET, NFR-SEC-03, D-21, D-37, D-39, handoff H-78

## Context
Akshay's dashboards (P-04) must be built against the browser-facing lab API, but IF-2 did not exist: `contracts/api/lab/` was empty, and the documents disagreed on paths (`/api/instances`, `/attempts/ID/flags`) and on who owns hints, reports and attempt routes. Three things needed a decision before the file could be written: how routes are prefixed, what the mock is, and which routes belong to the lab.

## Options considered
1. **Route prefix.** (a) No version, as in the examples of architecture 03 to 05. Simple, but a later incompatible change has no place to go. (b) `/api/v1/` for every route. One prefix for both fragments, the version is visible, and IF-5 already uses `/v1/`. Chosen.
2. **Mock.** (a) Prism, as architecture 07 section 3.1 says. It serves examples from an OpenAPI file with no code, but it is a new dependency, it serves fixed or generated examples and checks requests against the schema, so a flag result by input, a rate limit or a reset that raises an epoch would need code of our own (the Prism pages read do not say outright that it keeps no state; they list "data persistence" as a roadmap item), and the tool was UNVERIFIED in the architecture (ADR 0012 asks for confirmation). (b) A dependency-free Node fake in the pattern of `fake-orchestrator` and `fake-ingest`. It holds a small state, answers every operation and runs in the existing test setup. Chosen. Cost: it is code we maintain, and it can drift from the file; a conformance test (every answer validated against the OpenAPI response schemas) guards that.
3. **Scope.** (a) Lab and platform routes together. Blocks on Akshay's IF-1 and mixes owners. (b) Lab-owned routes only, using one rule: a route is lab-owned when it reads or changes the tables the lab owns (architecture 07 section 5). Platform routes (login, consent, create-attempt-from-consent, cancel, withdraw, purge, exports, admin, live stream) are listed as handoff rows. Chosen.
4. **Attempt start.** The clock rule is OPEN (OI-22). The route is included and marked pending, with both outcomes written in the open-points table, rather than left out (which would leave the dashboard with no way to start) or fixed (which would decide OI-22).

## Decision
`/api/v1/` for every route; a Node mock with no dependency; lab-owned routes only; the start route pending OI-22. Browser rules are those of architecture 03 (cookie `__Host-vm_session`, CSRF header, Origin check, JSON only, `Cache-Control: private, no-store`). Errors use the media type `application/problem+json` with our own members (`code`, `message`, `request_id`, `field`): "problem-details style", not the RFC 9457 member names. Decided 2026-10-09 (M1): adopt RFC 9457 in story 1.12; until then the contracts keep the members above. States, access and health are copied from IF-5 and a check fails if they drift. Everything the architecture does not fix (CSRF header name, paging, idempotency, time format, id shapes, error code names) is a proposal in the open-points table, none decided.

## Consequences
- The dashboards can be built now against the mock; the bundle script (P-04's) merges this fragment with IF-1.
- The mock must be kept in step with the file (a conformance test and a checker fail when they differ).
- Placeholder error codes become a breaking rename if the registry (P-02) chooses other names (handoff H-81).
- Open items stay open: OI-14, 15, 21, 22, 23, 24, 25, 26, 27, 38 each have both outcomes recorded in `lab-api.md`.

## Evidence
- Repository sources read in this task: `docs/architecture/03-origins-and-access.md`, `04-data-and-state.md`, `05-key-flows.md`, `07-repo-and-workstreams.md`, the PRD requirements named above, the IF-5 contract and its check, tests and mock (the patterns copied).
- Verified by running: `pnpm run contracts:check` (lab contract: 18 operations, 38 valid and 82 invalid examples, PASS), `apps/api/tests/test_lab_contract.py`, `scripts/e2e/lab.e2e.test.mjs`. Outputs in `docs/assets/l-05-lab-api/`; Linux run of all CI commands in `docs/assets/story-1-11-review-gaps/` (story 1.11).
- External sources, read in story 1.11 (2026-10-09) with a fetch tool that summarises the page, so the statements below are paraphrases and not verbatim copies; re-quote from the page before relying on exact wording. Standards read: RFC 9457, OpenAPI 3.1.0 (not the newest 3.1.x), the OWASP CSRF Prevention Cheat Sheet, the Prism README and mocking guide.

| Claim in our text | Source (URL, section) | What it says | Verdict |
|---|---|---|---|
| Errors use `application/problem+json` | https://www.rfc-editor.org/rfc/rfc9457.html, sections 1, 3, 6 | The JSON form of problem details uses that media type | Agrees |
| Our members are `code`, `message`, `request_id`, `field` | same, sections 3.1 and 3.2 | The standard members are `type`, `title`, `status`, `detail`, `instance`, all optional; a problem type may add extension members, and clients must ignore extensions they do not know; an absent `type` means `about:blank` (no meaning beyond the HTTP status) | Allowed, but not the standard names: mismatch M1 |
| `field` is a JSON Pointer | same, section 3 example | The example puts a JSON Pointer in a `pointer` member inside an `errors` array; the shape is type-specific, not normative | Agrees in spirit; ours names one field only |
| No stack trace in an answer | same, sections 4 and 5 | Generators are encouraged to avoid stack dumps | Agrees |
| `Cache-Control: private, no-store` on errors | same | Not addressed | Our own rule, neither supported nor contradicted |
| Session cookie as an `apiKey` scheme in a cookie, CSRF header as an `apiKey` in a header | https://spec.openapis.org/oas/v3.1.0, Security Scheme Object | `apiKey` has `in` of `query`, `header` or `cookie` and a `name` | Agrees |
| A POST needs both schemes at once | same, Security Requirement Object | Several schemes in one requirement object must all be satisfied; separate list entries mean "either" | Agrees if the file writes both in one object (it does: `sessionCookie` and `csrfHeader` in one entry, as in the POST operations) |
| Response headers `Cache-Control`, `Retry-After`, `Allow` declared | same, Header Object and Response Object | A response header named `Content-Type` is ignored; nothing about the three we use | Agrees |
| Bare `$ref` for responses and headers | same, Reference Object | Extra properties next to `$ref` are ignored | Agrees |
| Examples next to schemas | same, Media Type Object | An example should match the media type format | Agrees |
| CSRF: header `X-CSRF-Token` equal to the cookie `__Host-vm_csrf` ("double submit") | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html, "Double Submit Cookie" | A signed token bound to the session (HMAC with a server secret) is recommended; the naive form (cookie equals header only) is described as insecure and for reference only | Our text names no signing and no session binding: mismatch M2 |
| `__Host-` prefix on both cookies | same | A prefixed cookie cannot be overwritten from another subdomain; recommended together with SameSite | Agrees (SameSite is a platform cookie matter, not stated in the lab file) |
| Origin must equal the dashboard origin; missing Origin refused | same, "Verifying Origin With Standard Headers" | A missing Origin or `null` is not evidence of a same-origin request; match the full origin | Agrees |
| `Sec-Fetch-Site` | same, "Fetch Metadata" | Called the primary signal, with Origin as the fallback | We use Origin only: note M3 |
| Prism serves examples, no code | https://github.com/stoplightio/prism (README) and its mocking guide `docs/guides/01-mocking.md` (the docs.stoplight.io page answered 404) | Static generation by default, uses the examples of the file; dynamic mode with `-d`; validates requests against the schema | Agrees |
| Prism cannot keep state | same | No statement; "data persistence" is listed as a roadmap item | Not stated: wording of the ADR softened above |

Mismatches and the developer's decisions of 2026-10-09:
- **M1. DECIDED: adopt RFC 9457; change PENDING in story 1.12 (not made now).** The problem body is "problem-details style": media type of RFC 9457, but our own member names and a closed schema (no `type`, `title`, `status`, `detail`, `instance`). Decision: IF-5 and IF-2 move to the RFC 9457 members with `code`, `request_id` and `field` as extension members, media type `application/problem+json`. Until story 1.12 lands, the contracts, examples, fakes and mocks are unchanged. Handoff H-91 for Akshay.
- **M2. DECIDED: signed, session-bound CSRF token.** The CSRF token is an HMAC of the session id with a server secret, sent in the CSRF header and checked together with the Origin check; `Sec-Fetch-Site` is also checked where the browser sends it (this also covers M3). The lab mock keeps its simple equality check with the cookie and the text says so. The contract text and the OpenAPI description are updated; the implementation is Akshay's in P-05 (handoff H-90). Source: OWASP "Double Submit Cookie" recommends the signed, session-bound form and calls the naive one insecure.
- **M3. Covered by M2** (`Sec-Fetch-Site` checked where sent).- **Unread:** OpenAPI 3.1.1 and later 3.1.x; whether the Prism security guide (conflicting README and guide text) validates cookie or header keys; any text on `Set-Cookie` in the OpenAPI header object (the login route that sets cookies belongs to the platform, not to this file).