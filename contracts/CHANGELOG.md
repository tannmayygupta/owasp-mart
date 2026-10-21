# Contracts changelog

Every change to a contract under `contracts/` adds an entry here (architecture 07 section 3, rule 4).

## Versioning rule

- Contracts are `0.x` until the tag `contracts-v1.0.0` (story L-09).
- Additive change (new optional field, new endpoint, new event type, new error code, new allowed value): **minor** bump.
- Rename, removal, retyping, or making an optional field required: **breaking**. It needs approval from every consumer and an expand-then-contract path. Before v1.0.0 it bumps the minor number and is declared here with a bullet line that starts with `BREAKING:` and a reason (exact case; "no BREAKING changes" does not count); from v1.0.0 it is a major bump.
- Tags are `contracts-vX.Y.Z`.
- CI enforces these rules with `node scripts/check-contract-rules.mjs` (story L-07, job `contract-rules`), reading `contracts/registry.json`: a change to a registered contract needs a new line in its own section below; a change to a schema or OpenAPI file also needs a change under its mock paths, or a line `no mock change: <reason>` in the new entry; a breaking change (deleting a whole contract included) needs a `BREAKING:` line and a raised version in the same section; a pull request that changes the registry, the checker, the diff scripts, the oasdiff pins or the workflows needs a new line `registry change: <reason>` (story 1.15, D-46); a new folder under `contracts/` needs a registry entry.
- registry change: `.github/workflows/ci.yml` gets a new job `shop-instance` (builds the shop image and runs the instance harness; work package D, 2026-10-21). No contract file, rule, pin or checker changes.
- registry change: `scripts/check-contract-rules.mjs` (rule `approvals`) and `contracts/COMPAT.md` on 2026-10-21 (D-105, ADR 0095): a line `**Sole maintainer:** @handle` in the base COMPAT.md makes a pull request authored by that handle pass the approvals rule, because nobody else can review it; the breaking-change diff, validators, changelog, mock and registry rules are unchanged. Without it the first contract change after the tag `contracts-v1.0.0` could not be merged.
- registry change: `contracts/COMPAT.md` is edited on 2026-10-21 (decisions D-102 and D-104: the team is the leader and Claude, and Claude approves under the leader's standing authority). The three rows that were `pending` for former developers (IF-2 2.1.0 consumer, DB 2.2.0 owner, DB 2.2.0 consumer) now name `@tannmayygupta` and are `approved`. Evidence: `apps/api/tests/test_table_owners.py` and `test_lab_contract.py` 191 passed, `pnpm run api:check` clean, the typecheck of `apps/web` against the regenerated types clean, `pnpm run contracts:rules` 16 PASS 0 FAIL, and the sign-off method is the standard one for a single maintainer: breaking-change detection by oasdiff plus the consumers' own test suites. No contract file changes.
- registry change: `.github/workflows/ci.yml` gets a step for the records check (`scripts/check-records.mjs`), a Valkey service for the api job and the release gate in the exploit-runner job (tracker audit 2026-10-21, story 12). No contract file, rule, pin or checker changes.

## Platform API (IF-1), `contracts/api/platform/`

### 1.8.0 (2026-10-21, Tanmay, work package B, ADR 0073)

- Additive, not breaking (the OpenAPI `info.version` is not changed here, as in the entries below): twelve operations that were implemented in services and had no route. Company: `listCompanyDeletionRequests` `GET /api/v1/company/deletion-requests`, `decideDeletionRequest` `POST .../{request_id}/decision`, `deleteCandidateRecord` `DELETE /api/v1/company/attempts/{attempt_id}` (the company side of candidate deletion requests, FR-PRV-08, FR-PRV-09, with the `escalated` flag), `listJoinRequests` `GET /api/v1/company/join-requests`, `decideJoinRequest` `POST .../{request_id}/decision`, `listCompanyMembers` `GET /api/v1/company/members`, `removeCompanyMember` `DELETE /api/v1/company/members/{user_id}` (colleagues, FR-ORG-03, owner only), `getCohort` `GET /api/v1/company/templates/{template_id}/cohort` (the private cohort view, D-93). Admin: `listCompanies` `GET /api/v1/admin/companies`, `setCompanyInviteCap` `PUT /api/v1/admin/companies/{org_id}/invite-cap`, and the decision `delete` is added to `decideCompany` (`CompanyDecisionRequest.decision`). Accounts: `requestEmailChange` `POST /api/v1/me/email` and `confirmEmailChange` `POST /api/v1/accounts/confirm-email-change` (FR-ACC-09). The `Template` answer gains the required member `cohort_board` and `TemplateRequest` the optional `cohort_board` (default false). The schemas `ChangeEmailRequest`, `ChangedStatus`, `CompanyDeletionRequest(List)`, `DeletionDecisionRequest`, `DeletedRecord`, `CompanyJoinRequest(List)`, `JoinDecisionRequest`, `CompanyMember(List)`, `Cohort`, `CohortRow`, `AdminCompany(List)`, `InviteCapRequest` and the response `AccountConflict` are added; no new error code. Behaviour of `acceptInvite` (documented, no new operation): an account whose email address is not verified is now answered 403 AUTH-EMAIL-NOT-VERIFIED (it was a 409 ATT-INVALID-STATE) and an account whose verified address is not the invite's is 409 ATT-INVALID-STATE with the Problem member `field` set to `/account/email` (the client then offers `resendVerification` or `requestEmailChange`); the invite's address is never said. The 403 response of `acceptInvite` gains this code in its description and example (an existing status, so not breaking). Not a contract change but made in the same pull request: the route of `openBreakGlass` now enforces the 20 to 500 characters the contract and the service already had, and the bulk invite body may be up to 192 KiB (500 addresses of 254 characters; the other routes keep 16 KiB). The bundle (81 platform operations, 101 in all) and the generated models and client are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (four valid and five invalid request examples added; the invalid example `admin-decision-bad-value` now uses `archive`, because `delete` became a value).
- registry change: `contracts/COMPAT.md` is edited: the IF-1 row of Versions names 1.8.0 and the DB row 2.2.0; the owner rows of IF-1 and DB and the consumer rows of DB are set to those versions with status `pending` until the leader signs them off (the one developer of the project now, 2026-10-21).

### 1.7.0 (2026-10-20, Akshay, story 3.6)

- Additive, not breaking: three operations for the caller's own sessions (FR-ACC-04): `listMySessions` `GET /api/v1/me/sessions` (the newest 100 live sessions: `ref`, times, a network prefix, the client kind, `current`), `logOutEverywhere` `DELETE /api/v1/me/sessions` (every session, this one included; clears the cookie) and `revokeMySession` `DELETE /api/v1/me/sessions/{ref}` (204 whether or not a live session had the ref; 422 for a malformed ref); the schemas `SessionRef`, `MySession`, `MySessionList`; no new error code. The bundle (69 platform operations, 89 in all) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples; none of them takes a body, so no request example is added.
- registry change: `contracts/COMPAT.md` is edited: the IF-1 row of Versions and Akshay's owner row of Approvals name 1.7.0 (approved by the developer for this change, 2026-10-20), so the tag's version check still matches the newest entry.

### 1.6.0 (2026-10-20, Akshay, story P-31, ADR 0062)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): six admin operations: `listAuditLog` `GET /api/v1/admin/audit`, `listBreakGlassSessions` and `openBreakGlass` on `/api/v1/admin/break-glass`, `readBreakGlassAttempt` `GET /api/v1/admin/break-glass/{session_id}/attempt`, `closeBreakGlass` and `reviewBreakGlass` (`POST .../close`, `.../review`); the schemas `AuditEntry`, `AuditEntryList`, `BreakGlassRequest`, `BreakGlassReviewRequest`, `BreakGlassSession`, `BreakGlassSessionList`, `BreakGlassRead`; no new error code (the admin area's `AdminNotFound` and `AdminConflict`). The bundle (66 platform operations, 86 in all) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (two valid and one invalid request example added; `scripts/platform-mock.test.mjs` 20 of 20).
- registry change: `contracts/COMPAT.md` is edited for the sign-off at the current versions (story P-08, 2026-10-20, Akshay): the IF-1 row of Versions names 1.6.0, and stream P's eight Approvals rows are set to approved (IF-1 1.6.0, IF-3 1.0.0, IF-8 1.0.0, DB 2.1.0 as owner; IF-2 1.2.0, IF-4 1.0.0, IF-5 1.1.0, IF-7 1.2.0 as consumer). No contract file changes (no mock change: sign-off only); the review is `docs/reviews/2026-10-20-p08-contract-sign-off-current.md`.

### 1.5.0 (2026-10-20, Akshay, story P-29, ADR 0060)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): two export operations, the tag `exports`: `exportMyData` `POST /api/v1/me/exports` and `exportCompanyResults` `POST /api/v1/company/exports` (the schema `CompanyExportRequest`), both answering `application/zip` with `Content-Disposition: attachment`; no new error code. OI-27 answered by the developer: scores as CSV and JSON, no evidence. The bundle (60 platform operations, 80 in all) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (one valid and one invalid request example added; `scripts/platform-mock.test.mjs` 20 of 20).

### 1.4.0 (2026-10-20, Akshay, story P-27, ADR 0059)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): thirteen recruiter operations, the tag `company`: `signupRecruiter` `POST /api/v1/recruiters` (no session, 202 like `createAccount`), `getMyCompany` `GET /api/v1/company`, `reapplyCompany` `POST /api/v1/company/reapply`, `getCompanyTerms` and `acceptCompanyTerms` on `/api/v1/company/terms`, `listTemplates` and `createTemplate` on `/api/v1/company/templates`, `getTemplate`, `updateTemplate` and `deleteTemplate` on `/api/v1/company/templates/{template_id}`, `listCompanyInvites` and `createInvites` on `/api/v1/company/invites`, `actOnInvite` `POST /api/v1/company/invites/{invite_id}/actions`; the schemas `RecruiterSignupRequest`, `CompanyStanding`, `CompanyTerms`, `TermsAcceptRequest`, `TemplateRequest`, `Template`, `TemplateList`, `InvitesRequest`, `InviteActionRequest`, `CompanyInvite`, `CompanyInviteList`, `InvitesResult`; the responses `CompanyNotFound` (404 `ATT-NOT-FOUND` or `REQ-ROUTE-UNKNOWN`) and `CompanyConflict` (409 `ATT-INVALID-STATE` or `ATT-CONSENT-STALE`); no new error code. The bundle (58 platform operations, 78 in all) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (five valid and three invalid request examples added; `scripts/platform-mock.test.mjs` 20 of 20).

### 1.3.0 (2026-10-20, Akshay, story P-26, ADR 0058)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): three candidate operations (`openInvite` `POST /api/v1/invites/open` with no session, `acceptInvite` `POST /api/v1/invites/accept`, `listMyInvites` `GET /api/v1/me/invites`), the tag `invites`, the schemas `InviteTokenRequest`, `InviteSummary`, `MyInvite`, `MyInviteList` and the response `InviteConflict` (409 `ATT-INVALID-STATE`); no new error code. The bundle (45 platform operations, 65 in all) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (one valid and two invalid request examples added; `scripts/platform-mock.test.mjs` 20 of 20).

### 1.2.0 (2026-10-20, Akshay, story P-28, ADR 0057)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): thirteen admin-only operations under `/api/v1/admin/` (`listPendingCompanies`, `decideCompany`, `listUsers`, `actOnUser`, `forceStopInstance`, `listSettings`, `updateSetting`, `resetSetting`, `listQuotas`, `setQuota`, `removeQuota`, `getCapacity`, `listJobs`), the tag `admin`, the schemas `PendingCompany`, `PendingCompanyList`, `CompanyDecisionRequest`, `AdminUser`, `AdminUserList`, `UserActionRequest`, `UserActionResult`, `ForceStopResult`, `AdminSetting`, `AdminSettingList`, `SettingUpdateRequest`, `Quota`, `QuotaList`, `QuotaRequest`, `Capacity`, `JobStatus`, `JobStatusList`, the responses `AdminNotFound` (404 `REQ-ROUTE-UNKNOWN`, also for a non-admin) and `AdminConflict` (409 `ATT-INVALID-STATE`); no new error code. The bundle (42 platform operations) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (two valid and four invalid request examples added; `scripts/platform-mock.test.mjs` 20 of 20).

### 1.1.0 (2026-10-19, Akshay, story P-25, ADR 0055)

- Additive, not breaking (the sign-offs of COMPAT.md stay on 1.0.0 until the owners confirm the minor label; the OpenAPI `info.version` is not changed here): four operations (`createDeletionRequest` `POST /api/v1/me/deletion-requests`, `listMyDeletionRequests` `GET` on the same path, `cancelDeletionRequest` `DELETE /api/v1/me/deletion-requests/{request_id}`, `listMyDataViews` `GET /api/v1/me/data-views`), the tag `privacy`, the schemas `DeletionRequestId`, `DeletionRequestCreate`, `DeletionRequest`, `DeletionRequestList`, `DataView`, `DataViewList`, the response `DeletionConflict` (409 `ATT-INVALID-STATE`); no new error code. The bundle (47 operations) and the generated models are regenerated. no mock change: the mock is a server of the bundle and serves the new operations from their examples (three valid and three invalid request examples added; `scripts/platform-mock.test.mjs` 20 of 20).

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.1.0 (2026-10-11, Akshay, story P-04)
- registry change: IF-1 is registered in `contracts/registry.json` (new contract; `contracts/api/platform` was a reserved folder, now owned by stream P with its OpenAPI file, mock, conformance scripts and generated code).- First draft: `platform.openapi.yaml` (OpenAPI 3.1, 25 operations on 21 paths under `/api/v1/`): health; account creation and e-mail verification; session (sign in, MFA step, read, sign out); profile, password and MFA enrolment; password reset; consent notice and record; challenge catalogue; own attempts; live stream (`GET /live` as SSE, `GET /live/snapshot`, `POST /live/ticket` marked `x-pending` until story S-14). Session cookie `__Host-vm_session`, CSRF header `X-CSRF-Token` on every authenticated unsafe call (public ones have no session and no token, but the Origin check and a rate limit), every error is the closed IF-8 body (`application/problem+json`), public operations say `security: []`, every answer says `Cache-Control: private, no-store`. Every authenticated state-changing route that takes a body also declares 429.
- Bundle: `contracts/api/bundle/openapi.json` (43 operations: this fragment plus IF-2, written by `node scripts/bundle-openapi.mjs`, proven current by `pnpm run contracts:bundle:check`). IF-2 components that differ from a platform component of the same name are renamed with the prefix `Lab`; IF-2 keeps its own error bodies in the bundle (see the change request to stream L).
- Generated code, checked in CI (`pnpm run api:check`): `packages/ts-client/src/api.d.ts` and `packages/py-models/src/vulnmart_models/api.py`, from the bundle by `scripts/generate-api-code.mjs`. In the Python models an e-mail address is a plain string, and an object that must have at least one member is not expressed; the bundle and the API validate both.
- Mock: `contracts/mocks/platform-mock/server.mjs` (a Node server of the bundle: cookies, CSRF, origin and size checks, another declared answer through `Prefer: code=NNN` or `Prefer: example=NAME`, a fake SSE stream, an optional fake lab) with `scripts/platform-mock.test.mjs`.
- Checked by `scripts/check_platform_contract.py` (fragment and bundle rules, 14 valid and 21 invalid request examples), `scripts/check_api_models.py` and the type test of the client.
- Status: awaiting review by Tanmay (lab prefix in the bundle, IF-2 error bodies) and Sahil (catalogue fields the dashboards read).

## Domain events (IF-3), `contracts/domain-events/`

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.
- BREAKING: none in substance. The only change is the `contract_version` label in `audiences.json` (0.1.0 to 1.0.0); the rules engine flags a changed value as breaking on the safe side. Checked by hand: no member added, removed or retyped.

### 0.1.0 (2026-10-11, Akshay, story P-03)
- registry change: IF-3 is registered in `contracts/registry.json` (new contract in its own folder: `contracts/events/` is IF-4's folder in the registry, so the architecture's path `contracts/events/domain-events.schema.json` moved to `contracts/domain-events/`; `docs/architecture/07-repo-and-workstreams.md` is updated).
- First draft: `domain-events.schema.json` (one closed JSON Schema, seven types: `instance.state_changed`, `attempt.state_changed`, `attempt.milestone_reached`, `attempt.flag_captured`, `attempt.score_updated`, `attempt.hint_unlocked` and the control event `stream.resync`), `audiences.json` (who may receive what by attempt mode: learner practice never reaches a company; the candidate does not receive their own milestones, captures or score while OI-15 is open), the SSE wire format and the `Last-Event-ID` and `resync` rules (README), `fixtures/session.json` (18 ordered records), 8 valid and 25 invalid example events. The schema rejects impossible dates and a failed instance without an `error_code` (or a code on another state).
- State vocabularies and id shapes are copied from IF-2 and IF-5; `INST-*` codes come from IF-8. Handoff H-22 answered: `seq` is 64-bit, orchestrator and platform events use a reserved range from 2^40 up to 2^53 - 1, an infrastructure fault is shown as `instance.state_changed` with state `failed`. Stream layout (`live:user:<id>`, `live:org:<id>`, `live:admin`, one `event` field per entry), delivery rules and the `resync` loop are in the README.
- Checked by `scripts/validate-domain-events.mjs` and `scripts/replay-domain-events.mjs` (`pnpm run domain-events:check`, in CI) with tests.
- no mock change: the fixtures and the replay script are the stub of this contract (`noMock` in the registry).
- Status: awaiting review by Tanmay (publisher side, `stream.resync`, audience table).

## Error codes and error format (IF-8), `contracts/errors/`

### 2.0.0 (2026-10-21, Tanmay with Claude, backlog story 12, ADR 0071)
- Additive: one code, `INST-NO-CAPACITY` (503, retryable): no instance can be started right now (the platform is at its limit or the orchestrator has no capacity); the lab API answers it instead of a 429. Constants regenerated (61 codes).
- BREAKING: none in substance. The rules engine cannot compare `error-codes.yaml` and treats any change as breaking, so the major number is raised (the same reading as IF-2 2.0.0). Checked by hand: 1 added, 0 removed, 0 changed.
- registry change: `contracts/COMPAT.md` IF-8 row names 2.0.0 (the approval rows are the leader's to close). No mock change: no mock sends this code.
### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, label change plus one code (below); no mock change. Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.
- registry change: one code added before the tag, no breaking change: `INST-START-FAILED` (`status` null, `retryable` true), the `error_code` the orchestrator sets on an instance that could not be started (`apps/orchestrator`, states). Checked by hand: 1 added, 0 removed, 0 changed.

### 0.4.0 (2026-10-12, Tanmay for stream L, story "IF-8 error bodies", condition F-2 of the contracts sign-off; for Akshay to confirm)
- Additive: three codes that the Python orchestrator service and the IF-5 contract name and that the seed did not have: `ORCH-CURSOR-INVALID` (422, a list cursor that this orchestrator did not hand out), `ORCH-UNSUPPORTED-MEDIA-TYPE` (415) and `ORCH-NOT-IMPLEMENTED` (501, the reset placeholder of the Python service; never in the OpenAPI file). Titles are generic sentences like the others. Constants regenerated (59 codes).
- BREAKING: none in substance. This line only satisfies the rules engine, which cannot compare `error-codes.yaml` and flags any change to it as breaking on the safe side. Checked by hand: 3 added, 0 removed, 0 changed.
- registry change: `contracts/registry.json` names `contracts/mocks/shared` (the one builder of the IF-8 body for the Node mocks) as a mock of IF-8, and `contracts/COMPAT.md` is edited: the Versions and Approvals rows of IF-8, IF-2, IF-4, IF-5 and IF-6 name the new versions (all Approvals stay `pending`; nobody is marked approved).
- no mock change: the generated constants are the stub of this contract (`noMock` in the registry).

### 0.3.0 (2026-10-11, Akshay, story P-04, code review)
- Additive: `AUTH-MFA-STATE` (409: the second factor is already active, or an admin turns it off) and `ATT-CONSENT-STALE` (409: the consent notice the person saw is not the current one). They replace the use of `ATT-INVALID-STATE` for these two cases in IF-1. Constants regenerated (56 codes).
- BREAKING: none in substance, see 0.2.0 (the rules engine flags any change to `error-codes.yaml`). Checked by hand: 2 added, 0 removed, 0 changed.
- no mock change: the generated constants are the stub of this contract (`noMock` in the registry).

### 0.2.0 (2026-10-11, Akshay, story P-04)
- Additive: five codes for the platform routes of IF-1: `AUTH-EMAIL-NOT-VERIFIED` (403), `AUTH-INVALID-CREDENTIALS` (401), `AUTH-MFA-INVALID` (401), `AUTH-TOKEN-INVALID` (400) and `REQ-RATE-LIMITED` (429, the generic rate limit that the deferred-work list of P-02 named). Constants regenerated (54 codes).
- BREAKING: none in substance. This line only satisfies the rules engine, which cannot compare `error-codes.yaml` (a YAML file outside `schemas` and `openapi`) and flags any change to it as breaking on the safe side. Checked by hand against `origin/main`: 5 codes added, 0 removed, 0 changed.
- no mock change: the generated constants are the stub of this contract (`noMock` in the registry).

### 0.1.0 (2026-10-11, Akshay, story P-02)
- registry change: IF-8 is registered in `contracts/registry.json` (new contract; `contracts/errors` was a reserved folder, now owned by stream P with its schemas, conformance scripts and a stated reason for having no mock).
- First draft: `error-codes.yaml` (49 codes in six families: `AUTH`, `ATT`, `EVT`, `INST`, `ORCH`, `REQ`; every code named in the merged contracts and in stream L's in-flight branches, under the names those contracts use), `error-codes.schema.json`, `problem.schema.json` (RFC 9457 members `type`, `title`, `status` plus `code`, `request_id`, optional `field` and `errors`; closed shape), 7 valid and 24 invalid example bodies, and `README.md`.
- `ATT-GONE` (410) is in the seed because IF-2 0.2.0 uses it (`att_gone`).
- Generated constants: `packages/py-models/src/vulnmart_models/error_codes.py` and `packages/ts-client/src/error-codes.ts` (`node scripts/generate-error-codes.mjs`).
- Checked by `scripts/validate-errors.mjs` and `scripts/generate-error-codes.mjs --check` (`pnpm run errors:check`, in CI) with tests.
- The injector exit codes 10 to 13 are `exit_code` on the four `INST-INJECT-*` codes.
- Streams L and T move their error bodies to this shape in their own stories: see `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`.
- Status: awaiting review by Tanmay (statuses, titles, the body shape change for IF-2, IF-4 and IF-5).

## Edge gate (GATE), `contracts/edge/`

### 1.0.0 (2026-10-19, Tanmay, release label, ADR 0029 amended)
- First stable release, no content change (no mock change: label only; the gate is shipped and runs live on vm-i since 2026-10-17, vectors and library unchanged). The status line of `gate-ticket.md` now says 1.0.0.
- registry change: `contracts/COMPAT.md` Versions and Approvals now list the real versions of the contracts that moved on after the first release label: IF-2 1.0.1, IF-5 1.1.0, IF-7 1.1.0, DB 2.0.0, and GATE 1.0.0 (was 0.1.0). The rows of IF-7 and DB that Sahil approved at 1.0.0 (2026-10-15) are back to `pending`, because the version changed; he approves again. No contract file other than `gate-ticket.md` (a status line) changed.

### 0.1.0 (2026-10-17, Tanmay, story L-17 gate core, ADR 0004 decided on delegation, D-60 D-63 D-68)
- registry change: GATE is registered in `contracts/registry.json` (new contract in its own folder `contracts/edge/`, owner L, no mock by design, conformance tests under `apps/edge/test/`), and `contracts/COMPAT.md` gets its Versions row and its owner row in Approvals (`pending`).
- First draft: `gate-ticket.md` (HMAC ticket valid 60 s and single use, host-only `__Host-vm_gate` cookie bound to instance, owner hash and access epoch, strict hostname rule `^i-[a-z2-7]{16}\.<zone>$`, access state pushed by the orchestrator with the IF-5 epoch rule, admin API under `/internal/v1/gate/`, decision order, open points) and `examples/ticket-vectors.json` (31 ticket and 12 cookie vectors with fixed throwaway keys and a fixed time).
- Checked by `apps/edge/test/vectors.test.mjs` and `apps/edge/test/gate.test.mjs` (`node --test apps/edge/test/*.test.mjs`).
- no mock change: new contract; the vectors and the library are the reference (`noMock` in the registry).
- Status: awaiting review by Tanmay (decisions of delegation) and Akshay (the API signs the ticket with this format; the platform handoff is in story 5).

## Instance contract (IF-6), `contracts/instance/`

### 1.0.1 (2026-10-20, Tanmay, story L-30 support bot, ADR 0061)

- The example templates give the two components of the live C03 part B loop the addresses they need, using names that were already allowed in section 2: `mock-services` gets `VM_INSTANCE_ID` (the collector checks its id against it) and `VM_SIDECAR_EVENTS_URL` (it reports `collector.hit`); `bot-controller` gets `VM_SIDECAR_EVENTS_URL` (it reports `bot.visit`) and `VM_MOCK_URL` (the collector is the one address besides the shop its browser may reach). No schema change, no new name, no change to the injection document or the sidecar start.
- registry change: none to `contracts/registry.json`.

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.3.2 (2026-10-12, Tanmay, story "IF-8 error bodies")
- Editorial, no schema change: the words "placeholder until the registry is merged" are removed from `instance-contract.md` (the `INST-*` names, among them the injector codes of section 5, are the codes of the IF-8 registry).

### 0.3.1 (2026-10-11, Tanmay, story L-09 preparation)
- Editorial, no schema change: the template-hardening entry below was numbered 0.2.0 a second time; it is renumbered 0.3.0 so that every IF-6 version is unique (`contracts/COMPAT.md` lists versions). Open points 20, 21 and 26 of `instance-contract.md` are marked confirmed on delegation by Tanmay (handoff H-82); the written proposals stand.

### 0.3.0 (2026-10-11, Tanmay, story 1.15, instance template hardening; a minor step because it is breaking before v1.0.0)
- `instance-template.schema.json` now closes the holes found in the audit. Component `name` is one of the six role names and equals its role; `image` is exactly `{image:<role>}`; `network_mode` is fixed per role (`instance` for the shop, sidecar, mock-services and bot controller, `none` for the injector and import service); the injector has no `ports` and no `healthcheck`; the shop healthcheck path is `/readyz` (the contract text always said `/readyz`; the schema did not check it); `user` is exactly `65532:65532`; `memory_mb` 16 to 1024, `cpu_limit` above 0 up to 2, `pids_limit` 1 to 512, volume `size_mb` up to 64, tmpfs `size_mb` up to 512 (maxima are about twice the largest example and are proposals, to confirm after spikes S-4 and S-5); each `env` name has a value pattern or fixed value (URLs, socket, database and snapshot paths, `TZ`, log level, `PORT`) and `env` is not empty; `vm.expires` is a token or a UTC date-time with a valid month, day, hour, minute and second; `flag_delivery_env.reason` must be a real sentence (no run of four equal characters, no double whitespace, at least three words).
- `scripts/validate-contracts.mjs` adds three semantic rules: `PORT` is one of `ports`, `vm.expires` is a real calendar date, a flag-in-env `reason` has at least 8 different letters or digits. Section 7 and open point text of `instance-contract.md` describe them.
- 40 new invalid examples under `examples/invalid/instance-template/` (each with its path in `examples/invalid/manifest.json`); no valid example changed.
- BREAKING: a template that used another run user than 65532:65532, a component name or image other than the role's own, network_mode other than the role's fixed value, a shop healthcheck path other than /readyz, limits above the new maxima, an env value outside its pattern or an empty env is now invalid
- no mock change: the stub instance mock (`contracts/mocks/stub-instance`) does not read `instance-template.schema.json`; the checkers that use it are `scripts/validate-contracts.mjs` and `scripts/check-instance-conformance.mjs`, both changed here with tests.
- `scripts/check-instance-conformance.mjs`: the helper-name allowlist (`ingest`, `volume-keeper`) is frozen and no longer a way to skip rules (new rule `harness-helpers-minimal`; `no-outside-network` now covers helpers too).

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42)
- BREAKING: `first_seq` is removed from the sidecar start document (`sidecar-start.schema.json`: no longer required, no longer allowed); the sidecar restarts its sequence counter at 1 in every epoch and stamps the `epoch` of the start document on every event (IF-4 0.2.0). The `event_key` in the document is now the 43-character base64url key derived per `(instance, epoch)`; the accepted shape (32 to 128 printable ASCII characters) is unchanged.
- Section 6 and open point 35 updated; the sidecar keeps its write-ahead counter in a file in its own `/tmp` (`/tmp/vm-sidecar-seq.json`). No new mount, volume or path is added to the template; a lost sidecar container loses the file (IF-4 open point 32).
- Examples: the two valid sidecar-start examples lose `first_seq`; the two `first-seq-*` invalid examples are replaced by `first-seq-removed` (a document that still has `first_seq` is refused).
- Mocks changed with it: `contracts/mocks/stub-instance` (sidecar counter, state file, epoch stamp, fixtures, ingest wrapper); it uses the shared key derivation in `contracts/mocks/fake-ingest/event-key.mjs`, which its image already copies with the fake-ingest folder.

### 0.1.0 (2026-10-08, Tanmay, story L-02)
- First draft: `instance-contract.md` (the 11 topics of architecture 07 section 3.2, injector exit codes with placeholder `INST-*` names, versioning rule, table of open points to confirm).
- JSON Schemas 2020-12: `injection-document.schema.json`, `flags-file.schema.json`, `instance-template.schema.json`.
- Examples: 5 valid and 129 invalid, each invalid one with its expected error path in `examples/invalid/manifest.json`.
- Two more memory-backed volumes, `vm-placement-import` at `/run/placement/import` and `vm-placement-mock` at `/run/placement/mock`, carry the flag files for the import service and mock-services (injector read-write, one consumer each read-only). The injector has `network_mode: none`.
- Checked by `scripts/validate-contracts.mjs` (`pnpm run contracts:check`).
- Status: merged in pull request #2 with all CI checks green; Sahil's consumer approval waived (D-37); the open-points table is still to be confirmed by Sahil and Akshay in the team chat.

### 0.1.1 (2026-10-09, Tanmay, story L-03)
- Section 6 and open point 22 now point at IF-4 and name the event path `/v1/events` (changed in substance, not only editorial: the path and the event body are now fixed by IF-4). Approval of this change is waived under D-37.

### 0.1.2 (2026-10-09, Tanmay, story L-04 follow-up)
- Additive, no schema change: section 4 notes that the `vm.owner` label value comes from the required `owner_hash` of the IF-5 create body (handoff H-20); section 6 says the orchestrator gives the sidecar the event key, flag digests and `first_seq` on standard input at start (handoff H-59); open points 23 updated and 35 added (sidecar start input).

### 0.1.3 (2026-10-10, Tanmay, story L-06)
- Additive: new schema `sidecar-start.schema.json` (the start document of the sidecar: `schema_version`, `instance_id`, `epoch`, `first_seq`, `event_key`, `flag_digests`), 2 valid and 24 invalid examples, one semantic rule in `contracts/mocks/stub-instance/semantic.mjs`, shared by `scripts/validate-contracts.mjs` and the stub (no repeated digest, one real digest per challenge key). Section 6 describes it; open point 35 is now a proposal with a shape (handoff H-59, for L-13 and L-20). Decided by Tanmay on 2026-10-10 as a proposal; Akshay and the orchestrator story confirm it.
- Additive note in section 7 and new open point 36: a Docker tmpfs volume is lost when its last container stops, so something must keep the four volumes mounted while the injector exits and the shop starts (found while building the L-06 harness).
- No change to the other three schemas, to IF-4, IF-5, IF-1 or IF-2.

## Lab API (IF-2), `contracts/api/lab/`

### 2.2.0 (2026-10-21, Tanmay with Claude, backlog story 12, ADR 0071: the attempt lifecycle, template settings, quotas and rate limits)
- Additive: one operation, `cancelAttempt` (`POST /api/v1/attempts/{attempt_id}/cancel`), for the recruiter of the owning company (FR-SES-07): a `ready` or `running` company attempt becomes `cancelled`, the instance is destroyed, the candidate sees the state in `getAttempt`. Documented responses added: `429 REQ-RATE-LIMITED` (per-account hourly limit) on `requestInstance`, `startAttempt`, `openInstance`, `resetInstance`, `stopInstance`, `releaseResults`, `decideIntegrityFlag`; `503 INST-NO-CAPACITY` (component `Unavailable`, with `Retry-After`) on `requestInstance` and `startAttempt`.
- Behaviour: a full orchestrator or platform answered 429 `REQ-RATE-LIMITED` before; it now answers 503 `INST-NO-CAPACITY` (new IF-8 code, registry 2.0.0). `startAttempt` checks the invite (a revoked, expired, declined or cancelled invite is 409 and cancels a ready attempt; a consented invite becomes `started`). The template's challenge subset, hints mode, hint cost and flags per minute now apply to `listChallenges`, hints, flags, score and report. No existing member, value or route changed.
- BREAKING: none in substance (no value of a response enum or member was added, removed or changed). The one visible change is the status of a full platform on `requestInstance` (429 to 503); no consumer relies on it (apps/web and lab-console show the problem text), so there is no contract step to follow.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` (`cancelAttempt`); example `examples/valid/attempt.cancelled.json`. Generated code and bundle regenerated.
### 2.1.0 (2026-10-20, Tanmay, backlog story 10, handoff H-355: the recruiter releases a candidate's results)
- Additive: one operation, `releaseResults` (`POST /api/v1/attempts/{attempt_id}/release`), for the recruiter of the owning company; the optional member `results_released` (boolean) of `Attempt`, present only on a company assessment whose invite says `after_release`. No existing value, member or route changed.
- Behaviour: when the invite says `after_release` the candidate's own `getScore` answers 404 and `listChallenges` shows nothing earned until the recruiter releases the finished attempt (OI-15, the developer's answer of 2026-10-18). `after_submit` (the default) and a learner's practice are as before.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs`; examples `examples/valid/attempt.released.json` and `examples/invalid/attempt-released-string.json`. Generated code and bundle regenerated.

### 2.0.0 (2026-10-20, Tanmay, backlog story 8, handoff H-359: time warnings in the timeline)
- Additive: the timeline type `attempt.time_warning` and the optional member `minutes_left` (1 to 1440) of `TimelineEntry`, present only on that type. `getTimeline` now lists the warnings the engine wrote (`time_warning_sent`, 15 and 5 minutes before the end by default), so the recruiter's report shows when the candidate was told time was running out. Nothing a client sends changed; a client that does not know the type shows it as text.
- BREAKING: the response enum `TimelineEntry.type` gains `attempt.time_warning` (the diff tool counts a new value of a response enum as breaking, because a client that switches exhaustively on the enum would not know it). Why it is safe here: the only consumer, the recruiter page of stream P (`apps/web`), printed the type as text and now maps it to words with a fallback for an unknown type; no value is removed or renamed, so there is no contract step to follow. The rule of this repository raises the major number for any new value of a response enum, which is why an additive change is labelled 2.0.0.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` (a seeded warning, the test hook accepts the type); examples `examples/valid/timeline.json` and `examples/invalid/timeline-bad-minutes.json`. Generated code and bundle regenerated.

### 1.3.0 (2026-10-20, Tanmay, backlog story 6: one challenge at a time with a countdown each)
- Additive: two operations. `beginChallenge` (`POST /api/v1/attempts/{attempt_id}/challenges/{challenge_key}/begin`) starts the countdown of the current challenge of a learner's practice run (Easy 20, Medium 40, Hard 60 minutes) and answers the challenge entry. `getMyProgress` (`GET /api/v1/me/progress`) answers the points on the learner's account: the best result per challenge over every run, `total_points` out of 1000, `runs`.
- Additive: `ChallengeProgress` gets optional members `state` (ready, active, solved, expired), `title`, `tier`, `time_limit_seconds`, `opened_at`, `expires_at`, `seconds_left`; `ChallengeProgressList` gets optional `total`, `current_key`, `server_time`. A sequenced run lists only the challenges the learner has reached; a company assessment and an attempt that is not sequenced answer exactly as before. New schemas `AccountProgress` and `AccountChallengePoints`.
- Behaviour (no new error code): a challenge that is not reached answers 404 ATT-CHALLENGE-NOT-FOUND on begin, hints and flags; a challenge not begun, or already ended, answers 409 ATT-INVALID-STATE. Nothing a client sends changed.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` (a sequenced seed attempt `a-HHHHHHHHHHHHHHHH`, the two operations, the gates); examples `examples/valid/challenges.sequenced.json`, `challenge.begun.json`, `account-progress.json` and two invalid ones. Generated code and bundle regenerated.
- registry change: none; `scripts/check_lab_contract.py` now lists the 22 operations and the schemas `ChallengeProgress` and `AccountProgress` among the ones that need an example.

### 1.2.0 (2026-10-20, Tanmay, story L-30 player experience)
- Additive: `ChallengeProgress` gets three optional members: `brief` (what the challenge is about), `start` (how to begin: the documented demo account to sign in with and where to look) and `write_up` (the weakness and the fix; only for the owner of a practice attempt once the challenge is captured, never in an assessment, never a flag). The route `listChallenges` fills them from the catalogue. Nothing a client sends changed.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs`; example `examples/valid/challenges.json`. Generated code and bundle regenerated.
- registry change: none to `contracts/registry.json`; `contracts/COMPAT.md` lists IF-2 at 1.2.0 and IF-7 at 1.2.0.

### 1.1.0 (2026-10-19, Tanmay, story L-26 routes; for Akshay to confirm, handoff H-353)
- Additive: `POST /api/v1/attempts/{attempt_id}/withdraw` (`withdrawAttempt`, body `{ "confirm": true }`) and `POST /api/v1/attempts/{attempt_id}/withdraw/undo` (`undoWithdrawal`, empty body), both 200 with the `Attempt`; only the owner of a candidate attempt; a learner attempt, a wrong state is 409 `ATT-INVALID-STATE`, an unknown or foreign attempt is 404, a closed undo window is 410 `ATT-GONE` (no new error code). New optional field `Attempt.delete_after` (the end of the undo window while the attempt is `withdrawn` and its deletion is scheduled, otherwise null).
- Why in this contract and not in IF-1: the lab already serves the attempt routes and owns the state machine and the undo window (D-91); the decision text "cancel, withdraw and purge are IF-1" of `lab-api.md` is changed by this entry for withdraw and undo only. Cancel (a recruiter's action) and purge stay with the platform.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` (both routes, the seed withdrawn attempt carries a deletion date). Generated code and bundle regenerated: `contracts/api/bundle/`, `packages/ts-client/src/api.d.ts`, `packages/py-models/src/vulnmart_models/api.py`. Two examples: `attempt.withdraw.request.json`, `attempt.withdrawn.json`.
- registry change: none to `contracts/registry.json`; `contracts/COMPAT.md` lists IF-2 at 1.1.0 (the IF-2 approval rows are pending again).

### 1.0.1 (2026-10-18, Tanmay, story 9.2)
- Fixed: the gate ticket in `openGateUrl` answers `...?t=<payload>.<signature>` (two base64url parts joined by a dot, as the API mints it and the edge gate verifies it); the `url` pattern of `Ticket`, `lab-api.md` and the valid and invalid examples now say so (the pattern had no dot, which no real ticket matches). No other schema change; nothing a client could send changed.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` mints the same two-part ticket. Generated code and bundle regenerated: `contracts/api/bundle/`, `packages/ts-client/src/api.d.ts`, `packages/py-models/src/vulnmart_models/api.py`.
- registry change: none to `contracts/registry.json`. This pull request also changes `.github/workflows/ci.yml` (a Postgres service for the api tests job, so the database tests run in CI) and `scripts/check-contract-rules.mjs` (an added row in the table-owners list is additive, a removed row or another owner is breaking; before, any change to that file was reported breaking); both are stream L's, covered by `scripts/check-contract-rules.test.mjs`.

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.3.0 (2026-10-12, Tanmay, story "IF-8 error bodies", condition F-2 of the contracts sign-off; to be confirmed by Akshay)
- BREAKING: every error answer is the closed IF-8 body (`contracts/errors/problem.schema.json`): `type` is `urn:vulnmart:error:<CODE>` (was `https://vulnmart.invalid/problems/<code>`), `code` is the registry code in upper case with hyphens (`ATT-NOT-FOUND`, was `att_not_found`), `title` is the registry's fixed sentence, the members `detail` and `instance` are removed, and the `Problem` schema is closed (`additionalProperties: false`; it was open). `ProblemCode` is removed. `Problem` is now identical to the platform one, so the bundle shares it (0 renamed components). `scripts/check_lab_contract.py` compares it with the IF-8 schema.
- BREAKING: `field` is a 422 only and is a pointer whose first segment names the location for a query parameter: `/query/limit`, `/query/cursor`, `/query/<name>` (was `/limit`, `/cursor`, `/<name>`). The 409 `ATT-INVALID-STATE` for an early hint level no longer carries `field` `/level`. A 422 can also use `errors` (a list of `pointer` and `detail`).
- The placeholder wording is removed from `lab-api.md` and `lab.openapi.yaml`: the code names are final in IF-8.
- Examples: 12 valid problem examples rewritten to the new body (plus `error.validation-errors`), the invalid ones rewritten and extended (`detail`, `instance` and the old https `type` are refused; the old lower-case code is refused).
- Generated code and bundle regenerated: `contracts/api/bundle/`, `packages/ts-client/src/api.d.ts`, `packages/py-models/src/vulnmart_models/api.py`.
- Mock changed with it: `contracts/mocks/fake-lab/server.mjs` (the body comes from `contracts/mocks/shared/problem.mjs`, which reads the registry).

### 0.2.0 (2026-10-11, Tanmay, story 1.15 part B4, which also carries story 1.12 for IF-2; to be confirmed by Akshay)
- BREAKING: the timeline is paged by an opaque forward cursor keyed by `(epoch, seq)` instead of a decimal offset; entries are sorted by that key, a cursor of version 0.1.0 (a base64url decimal offset) is now 422 `req_validation` with field `/cursor`, and the cursor never moves back (a client that wants a late IF-4 event of a smaller key reads again from the start, `cursor` left out). The Timeline answer gains the required boolean `has_more`.
- BREAKING: error answers are RFC 9457 problem details with the media type `application/problem+json`: new required members `type` (`https://vulnmart.invalid/problems/<code>`), `title`, `status`, `detail`, `instance` (`urn:vulnmart:request:<request_id>`); `code`, `request_id` and `field` stay as extension members. The member `message` is removed (it is `detail`), the `code` values are renamed to lower-case words with underscores (`att_not_found` for `ATT-NOT-FOUND`), and the Problem schema is open (unknown members are ignored by clients). Same form as IF-5 (the orchestrator side is changed by its own entry).
- BREAKING: the flag result the submitter sees is only `correct` or `incorrect`: the values `wrong`, `decoy`, `other_instance` and `stale_epoch` are removed from `FlagResult` (and from the timeline `result`), so the answer is not an oracle; the reason stays on the server. Every incorrect submission, whatever the reason, now counts for the rate limit of 5 per 10 minutes. The owner of a learner attempt no longer sees integrity flags of type `decoy` or `sharing`.
- BREAKING: every list answer gains the required boolean `has_more` (challenges, hints, evidence, integrity flags, timeline); `listEvidence` and `listIntegrityFlags` take `limit` (default 100, maximum 100, 422 above it); the timeline `limit` keeps default 50 and maximum 200 and 422 above it.
- Added (not breaking): 410 `att_gone` for the derived reads of a withdrawn or cancelled attempt, a proposal to confirm; a deleted attempt is the same 404 as a missing one; `getAttempt` shows the state for withdrawn and cancelled. The role table of section 1 is written out; where nothing is decided it says proposal, to confirm. Order of checks stated and made the same in the mock: the content type (415) comes before the lookup (404). A repeated correct flag is answered before the rate limit (the text said so; the mock now does).
- Examples (38 valid, 101 invalid now): 23 problem examples (11 valid, 12 invalid including old-style bodies), `flags.result.incorrect` replaces the four reason examples, `timeline.last-page`, 4 invalid examples of oracle reasons, list examples with `has_more`. Open points 8 and 30 changed, 32 to 36 added.
- Mock changed with it: `contracts/mocks/fake-lab` (cursor by `(epoch, seq)`, the test hook `POST /_fake/late-event`, problem details, `has_more` and `limit`, oracle collapse with the reason kept server side, role and state rules, three seed attempts in states withdrawn, cancelled and deleted). `scripts/check_lab_contract.py` forbids an oracle reason in `FlagResult` and ties `type`, `instance` and `code` together; tests in `apps/api/tests/test_lab_contract.py`, `scripts/fake-lab.test.mjs` and `scripts/e2e/lab.e2e.test.mjs`.

### 0.1.0 (2026-10-09, Tanmay, story L-05)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `lab.openapi.yaml` (OpenAPI 3.1, 18 operations under `/api/v1/`: instances request, get, open ticket, reset, stop; attempts get, start (pending OI-22), submit; flag submit; score; challenges; hints list and unlock; evidence; integrity flags with review decisions; per-candidate report; timeline) and `lab-api.md` (scope and ownership, shared enums, auth and cross-cutting rules, error placeholders, 30 open points).
- Instance states, access and health are identical to IF-5 (handoff H-78). Placeholder error codes `AUTH-*`, `ATT-*`, `INST-*`, `REQ-*` until the registry (IF-8, P-02) is merged.
- Examples: 38 valid and 82 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`). Mock: `contracts/mocks/fake-lab/server.mjs` (Node, no dependency, not Prism).
- Checked by `scripts/check_lab_contract.py` (last part of `pnpm run contracts:check`), `apps/api/tests/test_lab_contract.py` and `scripts/e2e/lab.e2e.test.mjs`.
- Platform-owned routes are not in this file; they are listed in handoff H-86. No change to IF-1, IF-4, IF-5 or IF-6.
- Status: awaiting optional confirmation by Akshay (consumer; handoffs H-84 to H-89).

## Orchestrator API (IF-5), `contracts/orchestrator/`

### 1.1.0 (2026-10-19, Tanmay, audit blocker B1)
- Additive: `POST /v1/instances/{id}/activity` (`reportActivity`, body `{ "at": <RFC 3339> }`, signed like the other calls, 200 with the instance status, 409 ORCH-INVALID-STATE when the instance is not ready, active or idle). Without it the real service never learned that a player was active, so the idle limit ran from `ready` and cut off players mid-attempt. Examples: `activity.request.json` and three invalid ones.
- Mock changed with it: `contracts/mocks/fake-orchestrator/server.mjs` (route, validation, `active` transition).
- registry change: none.

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.4.0 (2026-10-12, Tanmay, story "IF-8 error bodies", condition F-2 of the contracts sign-off; to be confirmed by Akshay)
- BREAKING: every error answer is the closed IF-8 body: `type` is `urn:vulnmart:error:<CODE>` (was `https://vulnmart.invalid/problems/<lower-case code>`), `title` and `status` are the registry's, the members `detail` and `instance` are removed and the `Problem` schema is closed (it was open on purpose in 0.3.0). What happened this time is written to the log under the `request_id`, never into the answer. `scripts/check_orchestrator_contract.py` compares the schema with the IF-8 one.
- BREAKING: `field` is a 422 only and always a JSON Pointer: `/image` for `ORCH-FIELD-FORBIDDEN` (was the bare name `image`), `/query/limit`, `/query/epoch`, `/query/instance`, `/query/<name>` and `/query/cursor` for the list query (were `limit`, `epoch`, `instance`, the name, `cursor`), `/path/instance_id` for a bad id in the path (was `/instance_id`).
- The placeholder wording is removed from `orchestrator-api.md` and the OpenAPI file: the `ORCH-*` and `INST-*` names are the registry's. `ORCH-CURSOR-INVALID`, `ORCH-UNSUPPORTED-MEDIA-TYPE` and `ORCH-NOT-IMPLEMENTED` are registered in IF-8 0.4.0 (they were missing from the seed).
- Examples: the valid error examples rewritten (the open `error.extension-member` is replaced by `error.busy` and `error.validation-errors`); the invalid ones rewritten and extended (`detail`, `instance`, the old https `type`, an extension member).
- Mocks and services changed with it: `contracts/mocks/fake-orchestrator/server.mjs` (body from `contracts/mocks/shared/problem.mjs`, the test control route answers 404 instead of 403 outside loopback so that the status is the registry's), the Python service `apps/orchestrator/` (`problems.py` takes title and status from `vulnmart_models.error_codes`; the package now depends on `vulnmart-models`), the Python client `apps/api/src/vulnmart/ports/` (the exception message is the `title`; the fake host gives the `/query/...` pointers).

### 0.3.0 (2026-10-11, Tanmay, story 1.15, review findings of pull request 3; decided on the developer's delegation, ADR 0028; to be confirmed)
- BREAKING: `StateReport` has a new required member `transition` (integer from 1 to 2^53 - 1), assigned by the orchestrator per `(instance_id, epoch)` (1, 2, 3 ... without gaps; a reset starts again at 1). The identity of a report is `(instance_id, epoch, transition)`; the platform answers 204 for a new one, 200 for an identical repeat, 409 `ORCH-REQUEST-MISMATCH` for another body, and keeps a lower number as history without moving the state back. A real re-entrant change (the same state twice) has its own number. `at` orders nothing. The platform answers of `POST /internal/v1/orch/state` gain 200, 409 and 415. A sender that does not send `transition` is refused with 422.
- BREAKING: every integer of the contract is an integer token on the wire, in the OpenAPI as `type: integer`, `format: int64`, a `minimum` and a `maximum` of at most 2^53 - 1 (9007199254740991; `index`, `limits.memory_mb`, `pids_limit`, `idle_minutes`, `max_minutes`, `epoch`, `access_epoch`, `transition`, the host numbers, the `epoch` and `limit` query parameters, `Problem.status`). `1.0`, `1e0`, a boolean, `NaN` and a number above 2^53 - 1 are 422 `ORCH-VALIDATION` with the field pointer; before, `1.0` and `1e0` were accepted by some readers and not by others. `limits.cpu_limit` stays a `number` (`format: double`) and is compared by value (`2` and `2.0` are one request). New section 2a of `orchestrator-api.md`.
- BREAKING: the error body is RFC 9457 problem details, media type `application/problem+json`: new required standard members `type` (`https://vulnmart.invalid/problems/` plus the lower-case code), `title`, `status`, `detail` and `instance` (`urn:vulnmart:request:` plus the `request_id`); `code`, `request_id` and `field` stay as extension members. The `message` member is removed (use `detail`). The `Problem` schema is now open (no `additionalProperties: false`): a client ignores members it does not know, so a member can be added later without a breaking change; `message`, `stack` and `trace` stay refused. Every error response of the file is `application/problem+json` and nothing else.
- Additive: new error codes `ORCH-UNSUPPORTED-MEDIA-TYPE` (415, a body that is not `application/json`) and `ORCH-CURSOR-INVALID` (422, a list cursor that this orchestrator did not hand out; the `Cursor` pattern is now exactly 24 characters, the base64url of an instance id). The order of checks is now stated: signature, the call exists, media type (415), shape (422), template, existence (404), state (409), capacity (429); 415 comes before 404, and a malformed body is 422 before an unknown instance is 404 (the mock used to look the instance up first).
- Examples: `transition` in the valid state report; new valid problem examples (cursor, media type, an extension member) and rewritten valid error examples; 29 new invalid examples (missing, `0`, negative, `1.0`, `1e0`, string, boolean and huge `transition`; integer fields written as floats or booleans; old-style, `message`, `stack`, `trace`, wrong `type`, string and float `status` problems). The check script reads the examples with a strict integer rule and checks int64 ranges, the open `Problem` schema and the media type of every error response.
- Mocks changed with it: `contracts/mocks/fake-orchestrator` (a strict JSON number reader, problem details on every 4xx and 5xx, transition numbers in the reports, the 415 check and the new order, the cursor check); Python side `apps/api/src/vulnmart/ports/` (`StateReport`, `ReportIngest`, strict integers in `FakeInstanceHost` and `HttpInstanceHost`, problem details parsing, a TLS context that does not verify is refused).

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42; only the `first_seq` and `event_key` lines; other IF-5 changes of this story are listed by their own entries)
- BREAKING: `first_seq` is removed from the create body and the reset body (`CreateInstanceRequest` and `ResetInstanceRequest` no longer list or allow it; the `FirstSeq` schema is gone). Every epoch restarts the sidecar counter at 1; event identity is `(instance_id, epoch, seq)` (IF-4 0.2.0). A body that still has `first_seq` is refused (422 `ORCH-VALIDATION`, field `/first_seq`).
- `event_key` stays in create and reset, and its meaning is now defined: the platform derives it per `(instance_id, epoch)` with HKDF-SHA256 (IF-4 section 4), so a reset always carries a new key. The accepted shape is unchanged (32 to 128 URL-safe characters; the derivation gives 43). Open points 11, 31 and 33 of `orchestrator-api.md` reworded.
- Examples: `first_seq` removed from the valid create and reset examples and from the other invalid ones; the six first-seq invalid examples are replaced by `create-first-seq-removed` and `reset-first-seq-removed`.
- Mocks changed with it: `contracts/mocks/fake-orchestrator` (no `first_seq` in the validation); Python side `apps/api/src/vulnmart/ports/` (`CreateRequest` and `ResetRequest` lose `first_seq`).

### 0.1.0 follow-up notes (2026-10-09, Tanmay, story L-04 follow-up; still the 0.1.0 draft, nothing was confirmed yet)
- Create body: new required `owner_hash` (64 lowercase hex, the opaque `vm.owner` label value, computed by the platform, never returned) and required `first_seq` (integer of at least 1). Reset body: new required `first_seq`; no `owner_hash` (the owner stays). Both are part of the request fingerprint; no GET answer returns either. Open points 31 to 33 added (sidecar start input, owner hash computation, event key across a reset). Handoffs H-20 and H-59.

### 0.1.0 (2026-10-09, Tanmay, story L-04)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `orchestrator.openapi.yaml` (OpenAPI 3.1: the seven calls and the signed state report `POST /internal/v1/orch/state`), `orchestrator-api.md` (state machine, signing and replay rules, idempotence, errors, limits, 30 open points).
- Examples: 15 valid and 33 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`) and a fixed signing vector.
- Placeholder error codes `ORCH-*` and `INST-*` until the registry (IF-8, P-02) is merged.
- Python side: `InstanceHost` protocol, `FakeInstanceHost` and `HttpInstanceHost` in `apps/api/src/vulnmart/ports/` (IF-9). Mock: `contracts/mocks/fake-orchestrator/server.mjs`.
- Checked by `scripts/check_orchestrator_contract.py` (second half of `pnpm run contracts:check`) and by `apps/api/tests`.
- Review fixes (still 0.1.0, nothing was confirmed yet): added `ORCH-METHOD-NOT-ALLOWED` (405 with `Allow`) and `Retry-After` on 429; create of a destroyed id is 409 `ORCH-INSTANCE-EXISTS` and an old-epoch create is 409 `ORCH-STALE-EPOCH`; an oversize body is refused (413, connection dropped) before the signature check; a repeated query parameter and a `limit` that is not a plain number are 422 `ORCH-VALIDATION`; open points 24 to 30 added (reset capacity for L-13, nonce memory per process, nested forbidden names, and others).
- Status: awaiting optional confirmation by Akshay (consumer).

## Instance events (IF-4), `contracts/events/`

### 1.0.1 (2026-10-21, the leader and Claude, work package D, H-43)

- Documentation only, no schema or example change (clarification, no version label change in COMPAT): section 7 of `app-events.md` now states the milestone mapping (H-43, OI-17): the catalogue `signal` text names the event type and field values, the platform rules file implements it, tests prove the vulnerable and the fixed build; the C09 M2 negative observation uses `shop.security_event_written`, which the shop now posts. no mock change: documentation only.
### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.3.0 (2026-10-12, Tanmay, story "IF-8 error bodies", condition F-2 of the contracts sign-off; to be confirmed by Sahil and Akshay)
- BREAKING: every error answer of the ingest is the closed IF-8 body: the member `message` is removed, `type` is `urn:vulnmart:error:<CODE>` (was `about:blank`), `title` and `status` are the registry's, and the 422 `errors` entries are `{ "pointer", "detail" }` (were `{ "path", "message" }`). The `EVT-*` codes are final (IF-8). Section 5 of `app-events.md` says so; the schemas `instance-events.schema.json` and `instance-events.posted.schema.json` do not change.
- no mock change in the schemas; the fake ingest changed with it: `contracts/mocks/fake-ingest/ingest.mjs` (body from `contracts/mocks/shared/problem.mjs`), `scripts/validate-events.mjs` (every error answer of the matrix must validate against the IF-8 schema), and the stub instance image (`contracts/mocks/stub-instance/Dockerfile` copies the registry and installs `js-yaml`). The stub sidecar's own answers on `/v1/events` (a proposal, section 3) keep their shape; they are not ingest answers.

### 0.2.1 (2026-10-11, Tanmay, story L-09 preparation)
- Editorial, no schema change: open point 4 now states the whole order of the ingest checks as section 5 has it (it had stayed at the 0.1.0 wording, without the epoch checks and the store-full answer); open points 3, 4, 13, 14, 19, 20, 22, 27 and 28 are marked confirmed on delegation by Tanmay (handoff H-82; point 28 had been left out of that handoff); the written proposals stand.

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42, decided on the developer's delegation; to be confirmed)
- BREAKING: new required wire field `epoch` (integer at least 1) in `instance-events.schema.json`; event identity is now `(instance_id, epoch, seq)` instead of `(instance_id, seq)`. Every epoch restarts the sidecar counter at 1. The posted schema does not contain `epoch` (the sidecar stamps it; a poster that sends it gets 422).
- BREAKING: the signing string of `X-VM-Signature` (label stays `v1` while the contracts are 0.x) is now `instance_id`, newline, `epoch`, newline, `seq`, newline, hex SHA-256 of the body. The three signed envelope examples are signed again.
- BREAKING: `seq` lanes per source are enforced by the schema (all below 2^53): sidecar, shop, import, mock, bot 1 to 2^40-1; orchestrator 2^40 to 2^41-1; platform 2^41 to 2^42-1. The valid orchestrator examples (`instance.flags_injected`, `infrastructure_fault`) move into their lane.
- Ingest rules (section 5 and 6): duplicates on `(instance_id, epoch, seq)` (same body 200, other body 409); after the signature check an `epoch` above the instance's current epoch is 401, an equal or lower one is accepted and stored under its own epoch (a late event of an old epoch is history, never credited to the new epoch); order by `(epoch, seq)`.
- Event key derivation defined (section 4, closes open point 2 as a proposal): HKDF-SHA256 (RFC 5869) from the platform master `K_evt`, salt `vm-evt-salt-v1`, info `vm-event-key-v1` 0x00 `instance_id` 0x00 decimal `epoch`, 32 bytes, base64url (43 characters); one key per `(instance, epoch)`. New `examples/event-key-vector.json` (fake master) checked by `scripts/validate-events.mjs` and, with an independent HKDF, by `scripts/e2e/events.e2e.test.mjs`.
- Sidecar counter: write-ahead state file in the sidecar's own `/tmp`, so a restart of the sidecar process inside one epoch never reuses a `seq`; new sidecar answer 503 when it cannot number an event. Open points 1, 2, 6, 8, 9, 20, 21, 25 reworded and 29 to 33 added.
- Examples: `epoch` added to every wire example; new invalid examples `epoch-missing`, `epoch-zero`, `epoch-string`, `orchestrator-seq-1`, `sidecar-seq-in-reserved-lane`, `platform-seq-in-orchestrator-lane`, `orchestrator-seq-in-platform-lane` and the posted `includes-epoch`.
- Mocks changed with it: `contracts/mocks/fake-ingest` (epoch, lanes, `--master`, `--epoch`, `POST /_fake/epoch`, per-epoch dedup), the shared `contracts/mocks/fake-ingest/event-key.mjs`, and `contracts/mocks/stub-instance` (sidecar).

### 0.1.0 follow-up notes (2026-10-09, Tanmay, story L-04 follow-up; still the 0.1.0 draft)
- The import service never posts: the shop posts `import.job` (source `import`) on its behalf after it has the job result over the unix socket (section 3 and the catalogue row; the posted schema and the examples do not change; handoff H-50).
- Sequence rules (section 6, open points 8 and 9): the platform gives the sidecar its first `seq` through the required `first_seq` of the IF-5 create and reset bodies; the event key is the same on a reset unless the key version is raised (proposal; handoff H-59).

### 0.1.0 (2026-10-08, Tanmay, story L-03)
- First draft: `app-events.md` (identity `(instance_id, seq)`, wire event, shop-to-sidecar and sidecar-to-ingest transport, signing, ingest answers, size caps, catalogue of 29 event types, table of 28 open points to confirm) and `instance-events.schema.json` (JSON Schema 2020-12, one data rule per type).
- Examples: 29 valid (one per type, the evidence one shows the `[FLAG-REDACTED]` marker), 3 signed requests, 6 valid and 10 invalid posted bodies, 51 invalid events, each invalid one with its expected error path in `examples/invalid/manifest.json`.
- `instance-events.posted.schema.json`: the body a shop, import service, mock service or bot posts to the sidecar, derived from the wire schema by `node scripts/validate-events.mjs --write-posted` (the check fails when it is stale); a posted evidence body is at most 2 KiB.
- Review fixes: signature over the raw bytes; same HMAC work for unknown instances; duplicate `(instance_id, seq)` with a different body answers 409 `EVT-DUPLICATE-MISMATCH`; the fake ingest keeps at most 100000 events (503); the flag-like check ignores case and sees `VM%7B` (best effort); `session_kind` `internal` only for import, orchestrator and platform; `proxy.flag_seen` envelope and data `challenge_key` must agree; bounded body read, timeout and option checks in the fake ingest server.
- Fake ingest in `contracts/mocks/fake-ingest/` (verifies signature, size, schema and duplicates; answers 202, 200, 401, 413, 422) with a signing helper.
- Checked by `scripts/validate-events.mjs` (`pnpm run events:check`; `pnpm run contracts:check` runs both checks).
- The challenge specs' `event_id` is dropped; `proxy.flag_seen` carries `kind` and `challenge_key`; `source` has seven values (decisions of 2026-10-08).
- Pointer changes in `contracts/instance/instance-contract.md` (see the IF-6 section above, 0.1.1).
- Status: names and open points await Sahil's review (optional under D-37) and Akshay's note on the `EVT-*` placeholders.

## Table owners (DB), `contracts/db/`

### 2.3.0 (2026-10-21, Tanmay, work package B)
- Additive: one row in `table-owners.yaml`, `email_changes` (owner accounts), created by migration `0018` (a pending change of an account's address: the new address and the hash of the single-use link mailed to it, one row per account; FR-ACC-09). The schema of every other table is unchanged. The application role may select, insert, update and delete the new table.

### 2.2.0 (2026-10-20, Tanmay, backlog story 6)
- Additive: one row in `table-owners.yaml`, `challenge_opens` (owner attempts), created by migration `0017`: when a learner began each challenge of a sequenced run, the start of its countdown. The same migration replaces the unique constraint `uq_attempts_user_id_template_id` of `attempts` by the partial unique index `uq_attempts_current`, so a learner can start a new run after a finished one (a company attempt stays one per invite). The schema is unchanged.
- no mock change: nothing runs against the table-owners list (`noMock` in the registry).

### 2.1.0 (2026-10-19, Akshay, story P-25)
- Additive: one row in `table-owners.yaml`, `data_views` (owner privacy), created by migration `0015` (the company-level view history, FR-PRV-11); `deletion_requests` was already listed and its columns are updated in architecture 04 section 2.7. The schema is unchanged.
- no mock change: nothing runs against the table-owners list (`noMock` in the registry).

### 2.0.0 (2026-10-18, Tanmay, story 9.1)
- BREAKING: declared only because the checker of the base commit reports every change to `table-owners.yaml` as breaking (it cannot compare that file); the content change is additive. This pull request teaches the checker to compare the rows (new row: additive; removed row or another owner: breaking), so later additions need no major step.
- Additive: five rows in `table-owners.yaml` for tables the lab needs that architecture 04 did not list: `held_captures`, `review_audit` (owner scoring), `attempt_events` (attempts), `bot_visits`, `security_events` (ingest). Created by migration `0010` (stream L); to be confirmed by Akshay.
- The schema is unchanged.
- no mock change: nothing runs against the table-owners list (`noMock` in the registry).

### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.2.0 (2026-10-12, Akshay, story P-05)
- Additive: `table-owners.yaml` written (H-95 shape confirmed as proposed): all 42 tables of architecture 04 sections 2.1 to 2.8 plus `deks` of the `vm_keystore` database, each with its owning module. Stream P: kernel, accounts, orgs, assessments, privacy, admin, notifications, live. Stream L rows (attempts, instances, scoring, ingest, flags) are proposals marked "To confirm by Tanmay"; the catalogue tables belong to `admin` (the sync job), to confirm by Sahil and Tanmay. The 13 module folders exist now (empty packages), so every owner passes `scripts/check_table_owners.py`.
- The schema is unchanged.
- no mock change: nothing runs against the table-owners list (`noMock` in the registry).

### 0.1.0 (2026-10-10, Tanmay, story L-07)
- First draft, a proposal for Akshay to confirm (tasks P-05 and P-06): `table-owners.schema.json`, the shape of `contracts/db/table-owners.yaml` (a `tables` list of `table` and `owner`, the owner being a module folder of `apps/api/src/vulnmart/` named in CODEOWNERS). The YAML file itself is Akshay's and does not exist yet; `scripts/check_table_owners.py` reports NOT-APPLICABLE until it does, then checks shape, owner names and duplicate tables.
- The registry has no mock for this contract (`no mock change: nothing runs against it`).

## Challenge catalogue (IF-7), `contracts/catalog/` and `challenges/catalog/`

### 1.2.0 (2026-10-20, Tanmay, story L-30 player experience; for Sahil to confirm)
- Data only, no schema change: the `start_state` text of C01 to C11 now tells the player how to begin (the documented demo account and its password, or "no account", and where to look), because a player who opens the shop has nothing else to go on. The accounts are the seeded demo accounts of `apps/shop/seed/contributions/010-challenge-accounts.mjs` and the baseline owner; they are not secrets. No flag, placement or test path is in any text.

### 1.1.0 (2026-10-18, Sahil, story T-30)
- Additive: three optional fields on a challenge entry — `brief` (a short player-facing description, never a flag), `write_up` (`{ vulnerable, fix }`) and `decoys` (string array of foil locations). Existing entries stay valid; a stub omits them. No mock change (the catalogue is data read by validators, nothing runs against it). Not breaking (new optional properties; `exploit_test` and `fixed_build` patterns unchanged — they stay logical references, with `challenges/catalog/README.md` noting the real self-test folders are `challenges/tests/cNN-<name>` and the fixed build is the `VM_CHALLENGE_<KEY>` env flag). `validate-catalog.mjs` now also requires a `complete` entry to have non-null milestone signals, non-null hints and a brief.
- All 11 `challenges/catalog/cNN.yaml` entries are now `status: complete` (T-30): milestone detection signals, the three hint texts, a flag-free brief, the vulnerable/fix write-up and decoy locations, filled from `docs/design/challenge-specs.md`.

### 1.2.1 (2026-10-21, the leader and Claude, work package D, H-42, H-43, H-331)

- Data and documentation only, no schema change (clarification; work package D, the leader and Claude, no schema change, no version bump): the milestone `signal` text of C01 M2, C03 M3, C05 M2, C07 M1, C08 M1 and M2, C09 M1 and C10 M1 is tightened to what the platform rules read; every entry now lists its decoy placements in `decoys` (H-42, H-331: kinds `shop-db` and `service-file`, described in `contracts/catalog/README.md`); the mapping of milestone to event name (H-43) is settled in IF-4 section 7. no mock change: the catalogue is data read by validators.
### 1.0.0 (2026-10-13, Tanmay, release commit, ADR 0029)

- First stable release, no content change (no mock change: label only). Every contract is labelled 1.0.0 in one commit so the sign-offs and the tag `contracts-v1.0.0` mark the same version.

### 0.1.0 (2026-10-09, Sahil, story T-02)
- First draft: `contracts/catalog/challenge.schema.json` (JSON Schema 2020-12, one challenge entry) and a short `contracts/catalog/README.md`.
- 11 stub entries `challenges/catalog/c01..c11.yaml` (`status: stub`): OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier, placeholder milestone summaries and three empty hint slots, provisional flag placement/delivery, start-state, exploit-test and fixed-build paths.
- Validator `scripts/validate-catalog.mjs` (`pnpm run catalog:check`) and tests `scripts/validate-catalog.test.mjs`: schema plus semantic rules (tier matches difficulty per D-32, key matches filename, exactly 11 entries, no real flag value). `js-yaml` 4.1.0 added as a pinned dev dependency.
- Full content (briefs, write-ups, decoys, filled hints, official-site id re-check) is T-30; each challenge's real milestone signals and confirmed flag placement come with its own story.

## Contract rules engine (L-07), `scripts/check-contract-rules.mjs`

### 2026-10-20 (Sahil, IF-6 1.0.1 consumer re-sign-off)
- registry change: in `contracts/COMPAT.md` the stream-T IF-6 consumer row is updated from 1.0.0 to 1.0.1 (approved 2026-10-20). Sahil's review: IF-6 1.0.1 (L-30, ADR 0061) is example-templates only — it gives mock-services and bot-controller the env addresses for the C03 part B live loop (`VM_INSTANCE_ID`, `VM_SIDECAR_EVENTS_URL`, `VM_MOCK_URL`, names already allowed in section 2); no schema change, no change to the injection document or the sidecar start, and nothing that affects the shop's own IF-6 consumption (readiness marker, snapshot, runtime profile, events). No rule, checker, registry, diff script, oasdiff pin or contract file changed; only the approval status.


### 2026-10-20 (Sahil, IF-7 1.2.0 owner + DB 2.1.0 consumer sign-off)
- registry change: in `contracts/COMPAT.md` the stream-T Approvals rows for IF-7 (owner) and DB (consumer) are set to `approved` at 1.2.0 and 2.1.0 (date 2026-10-20). Sahil's review: IF-7 1.2.0 is data-only (the player-facing `start_state` text of C01–C11 now names the seeded demo account and where to look; no schema change, no flag/placement/test-path in any text, the accounts match `apps/shop/seed/contributions/010-challenge-accounts.mjs`); DB 2.1.0 is additive table-owner rows (`data_views`, lab tables, `security_events`) that do not touch the shop (own SQLite) or the catalogue tables. No rule, checker, registry, diff script, oasdiff pin or contract file changed; only the approval status.

### 2026-10-20 (Tanmay, story L-30: COMPAT.md follows IF-2 1.2.0 and IF-7 1.2.0)
- registry change: `contracts/COMPAT.md` lists IF-2 and IF-7 at 1.2.0; the rows of @tannmayygupta for them are `approved` on 2026-10-20 (the developer's standing instruction for their own rows), the others are `pending`. No contract file, registry entry or rule changed.

### 2026-10-19 (Tanmay, story L-09: own sign-offs)
- registry change: the Approvals rows of `@tannmayygupta` in `contracts/COMPAT.md` are set to `approved` on 2026-10-19 at the versions listed there, on the developer's instruction in chat. No contract file, registry entry or rule changed.

### 2026-10-19 (Tanmay, story L-09: COMPAT.md follows the changelog after P-25)
- registry change: `contracts/COMPAT.md` lists IF-1 at 1.1.0 and DB at 2.1.0, the versions of the newest changelog entries of Akshay's story P-25 (the tag script checks that COMPAT.md equals the changelog); the approval rows of IF-1 and DB carry the same versions and are `pending`. No contract file, registry entry or rule changed.

### 2026-10-19 (Tanmay, story L-19: flag scan of every image in CI)
- registry change: the `check` job of `.github/workflows/images.yml` now builds each image with `--load` and runs `node scripts/scan-flags.mjs --image` on it, and the path filter lists `scripts/scan-flags.mjs`. Workflow change only: no change to the registry, the checker, the diff scripts, the oasdiff pins, any contract or any rule.

### 2026-10-18 (Sahil, Sprint 3 — exploit-runner installs workspace deps)
- registry change: the `exploit runner` CI job in `.github/workflows/ci.yml` now runs `pnpm/action-setup` and `pnpm install --frozen-lockfile` before the challenge tests, because the Sprint 3 challenge self-tests boot the real shop app (express/nunjucks) whereas the earlier `_example` test used only node built-ins. Workflow change only — no change to the registry, the checker, the diff scripts, the oasdiff pins, any contract, or any rule.

### 2026-10-15 (Sahil, Sprint 2 to main — images.yml path filters, PR #14 review A1)
- registry change: `.github/workflows/images.yml` adds `services/**` to the `push` and `pull_request` path filters, so a change to the new `services/mock-services`, `services/import-service` or `services/bot` images triggers the image build. Workflow change only — no change to the registry, the checker, the diff scripts, the oasdiff pins, any contract, or any rule. (The same change also adds an optional per-image `healthcheck` argv to `infra/images.json` and emits it from `scripts/images-release.mjs`; those files are not guarded contract paths.)

### 2026-10-15 (Sahil, T-03 contracts v1.0.0 sign-off)
- registry change: in `contracts/COMPAT.md` the four stream-T Approvals rows (IF-4 consumer, IF-6 consumer, IF-7 owner, DB consumer) are set to `approved` at version 1.0.0 — Sahil's sign-off. No rule, checker, registry, diff script, oasdiff pin or contract file changed; only the approval status.

### 2026-10-12 (Sahil, Sprint 2, T-11/T-12/T-13)
- registry change: the `app tests` CI job in `.github/workflows/ci.yml` now also runs `services/*/test/**/*.test.mjs`, so the new `services/mock-services`, `services/import-service` and `services/bot` test suites run in CI alongside `apps/*`. Workflow change only — no change to the registry, the checker, the diff scripts, the oasdiff pins, any contract, or any rule.

### 2026-10-11 (Tanmay, story L-09 preparation, ADR 0029)
- registry change: new rule `approvals` (starts with the first tag `contracts-v*`: a pull request that changes a contract needs one approval from an owner or consumer, or from every consumer other than the author when the change is declared BREAKING (if the author is the only consumer, one approval from any other listed person), never the author's own, never one given before a later change of the contract files; the approvers are read from the base copy of `contracts/COMPAT.md`); `compat` reads only the `## Versions` table; the job `contract-rules` fetches the pull request reviews in a separate step (`pull-requests: read`) and hands the file to the checker; new file `contracts/COMPAT.md` (also guarded: an edit of it needs a `registry change:` line; CODEOWNERS lists the three owners); new script `scripts/tag-contracts.mjs` (checks the preconditions and prints the tag commands, never pushes).

### 2026-10-11 (Tanmay, story 1.15)
- registry change: IF-7 (challenge catalogue, owner T) is registered and `contracts/catalog` is no longer reserved; the checker, its registry, the oasdiff pins and the workflow now run from the base commit (trusted checker, ADR 0026); deleting a whole contract is a breaking change; the marker is the exact line `BREAKING:`.
- registry change: `.github/workflows/ci.yml` gets a step `node scripts/check-asvs.mjs` in the `scripts` job on 2026-10-21 (work package G, task P-32): the ASVS 5.0.0 checklist `docs/security/asvs-checklist.md` must hold one row per requirement with a status, an owner and evidence whose files exist. No contract file changes, no rule of the contract checker changes.
