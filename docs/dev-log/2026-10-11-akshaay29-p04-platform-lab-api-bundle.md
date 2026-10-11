# Platform and lab API fragments, bundle, mock and generated clients (P-04, story 1.4)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-3 / local commit, not pushed |
| Status | Done; awaiting review by Tanmay (the `Lab` prefix and IF-2 error bodies in the bundle) and Sahil (catalogue fields); not pushed or merged |
| Report tag | contracts, API, mock, generated clients, BMAD cycle |

## Requirements covered
PB-3 (platform and lab API fragments with examples, bundle, mock and generated client). Related: FR-ACC-01 to 11, FR-PRV-01 to 03 and 13, FR-LIV-04 and 05, NFR-SEC-03, NFR-MNT-02, handoffs H-19, H-23, H-84 to H-91, H-97, H-98.

## Summary (plain language, 3-5 lines)
The dashboards can now be built against the API. The platform's browser routes (accounts, login, second factor, password reset, consent, challenge catalogue, my attempts, the live stream) are written as an OpenAPI file and merged with stream L's lab routes into one bundle of 43 operations. A mock server answers every platform route with its example, a typed TypeScript client and Pydantic models are generated from the bundle, and CI fails when any of them is stale.

## Why
P-07 (dashboards skeleton), P-26 and all of sprint 2 wait on a contract and a mock (PB-3). Stream L's rules engine already expected `pnpm run contracts:bundle:check` and `contracts/api/bundle/openapi.json`.

## What was built
- `contracts/api/platform/`: `platform.openapi.yaml` (OpenAPI 3.1, 25 operations on 21 paths under `/api/v1/`), `platform-api.md` (scope, rules, behaviour, tools, 20 open points), 14 valid and 21 invalid request examples.
- `scripts/bundle-openapi.mjs`: merges the two fragments (one definition of identical components, the IF-8 `Problem` authoritative, 9 differing lab components kept as `Lab<Name>`, `x-fragment` on every operation, no `/internal/` path, deterministic output, `--check`); `contracts/api/bundle/openapi.json` and `bundle-report.json`.
- `scripts/check_platform_contract.py`: structure, auth rules, `Cache-Control` constant, `application/problem+json` on every error, 429 on routes with a body, Problem equals IF-8, example validation, error examples against the registry, SSE frames against IF-3, request examples, bundle identity.
- `contracts/mocks/platform-mock/server.mjs`: cookie, CSRF, Origin, body rules, `Prefer: code=NNN` and `example=NAME`, fake SSE stream, lab routes forwarded to the fake lab.
- `scripts/generate-api-code.mjs` (`--check`): `packages/ts-client/src/api.d.ts` (openapi-typescript 7.13.0), `packages/py-models/src/vulnmart_models/api.py` (datamodel-code-generator 0.83.0); the client `createApiClient` (openapi-fetch 0.17.0) sends cookies and the CSRF header; `scripts/check_api_models.py`, a type-level test and a runtime test.
- IF-8 registry 0.3.0 (56 codes): `AUTH-EMAIL-NOT-VERIFIED`, `AUTH-INVALID-CREDENTIALS`, `AUTH-MFA-INVALID`, `AUTH-TOKEN-INVALID`, `REQ-RATE-LIMITED`, then `AUTH-MFA-STATE` and `ATT-CONSENT-STALE` from the code review.
- Registry entry IF-1, changelog, CODEOWNERS line, `package.json` scripts, `contracts:check` and CI (`api:check`), `ci:linux`, handoff answers, architecture 07 tool names.

## How it works
Each fragment is the source of truth for its routes. The bundler reads both, renames what differs, checks the rules and writes the bundle; everything else reads the bundle: the mock serves it, the generators turn it into types and models, the checks prove the committed files are current. Public routes have no session and no CSRF token but need the Origin check and a rate limit; authenticated writes need the cookie, `X-CSRF-Token` and the Origin.

## Files changed
- `contracts/api/platform/`, `contracts/api/bundle/`, `contracts/mocks/platform-mock/` (new)
- `contracts/errors/error-codes.yaml`, `contracts/registry.json`, `contracts/CHANGELOG.md`, `CHANGELOG.md`
- `scripts/bundle-openapi.mjs`, `scripts/generate-api-code.mjs`, `scripts/check_platform_contract.py`, `scripts/check_api_models.py` and the tests `scripts/bundle-openapi.test.mjs`, `scripts/generate-api-code.test.mjs`, `scripts/platform-mock.test.mjs`, `scripts/ts-client.test.mjs`, `apps/api/tests/test_platform_contract.py` (new)
- `packages/ts-client/` (client, tsconfig, type test, generated types), `packages/py-models/` (generated models, pyproject), `pnpm-lock.yaml`, `uv.lock`
- `package.json`, `.github/workflows/ci.yml`, `.github/CODEOWNERS`, `scripts/ci-linux.mjs`
- `docs/dev/HANDOFFS.md`, `docs/architecture/07-repo-and-workstreams.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`
- `docs/bmad/initiative-platform/`: story plan with the review log, `deferred-work.md`

## Decisions made
No ADR. By the developer on 2026-10-11: (1) scope is the sprint-2 slice of about 25 operations; (2) a small Node bundler with identical components once and differing lab ones under a `Lab` prefix; (3) a Node mock instead of Prism (Prism needs Node 24.18 or newer); (4) openapi-typescript with openapi-fetch and datamodel-code-generator, committed with freshness checks; (5) internal endpoints stay in IF-4 and IF-5; (6) handoffs confirmed as proposed. After the code review: 429 on every authenticated state-changing route with a body; two new 409 codes instead of reusing `ATT-INVALID-STATE`; no list cursor for the slice (open point 15).

## Tests
All on the developer's Windows 11 PC, Node 24.11.0, pnpm 12.10.1, uv 0.12.23. Outputs in `docs/assets/p-04-api-bundle/`.
- `pnpm run api:check`: bundle current (43 operations, 10 shared and 9 renamed components), generated code current, 90 model checks, `tsc --noEmit` passes.
- `node --test "scripts/*.test.mjs"`: 581 of 581 pass (55 new tests: bundler, generators and the type test run, the client at run time, the mock).
- `uv run --locked --package vulnmart-api pytest -q`: 789 passed (60 new in `test_platform_contract.py`, each rule broken on purpose).
- `pnpm run contracts:check`, `pnpm run errors:check`: pass. `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 3 NOT-APPLICABLE.
- NOT run: CI on a pull request; `pnpm run ci:linux` in Docker; Prism (not used).
- Traceability row: PB-3 in `docs/traceability.md`.

## Evidence
`docs/assets/p-04-api-bundle/`. Review log: Code Review section of the story plan; deferred items in `docs/bmad/initiative-platform/deferred-work.md`.

## Problems met and how they were fixed
- The tests found a validator crash on an exception without text, a 401 with two causes, a named-example fallback and several mock defects (wrong Origin answered with the e-mail-not-verified example, a cookie on the first step of a second-factor login).
- The rules engine cannot compare `error-codes.yaml` and flags any change to it; the changelog entries carry a `BREAKING:` line that says it is only that declaration (checked by hand: codes only added).
- The e-mail library of Pydantic refuses `.test`, `.local` and `.invalid`, which dev and test mail uses: the models treat an address as a string and the bundle enforces the format.
- Independent code review (4 lenses): 3 decisions taken, 10 patches applied, 5 deferred, 13 rejected.
- uv could not replace folders in the `.venv` under OneDrive; runs used a virtual environment outside OneDrive.

## Security notes (vulnerable parts only)
None; no vulnerable code. No flag, secret or personal data in any example or answer; the checker and the mock tests look for flag-like values, hashes and stack traces.

## Limitations and follow-ups
- Not pushed or merged. Tanmay should review the `Lab` prefix and the IF-2 error bodies kept in the bundle (his lab fragment uses its own error body and lowercase codes until story 1.12), and look at the YAML gap in his rules engine. Sahil: catalogue key form `C03` (API) against `c03` (IF-7).
- Deferred (see `deferred-work.md`): the lab half of the mock is only checked for reachability, no parameter validation in the mock, no `/live` helper in the client, no account-deletion route.
- P-06 and P-07 must change P-01's rewrite to keep the `/api` prefix and use `GET /api/v1/health`.
