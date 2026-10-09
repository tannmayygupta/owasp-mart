# 0019. Lab API conventions: route prefix, Node mock, scope

- **Status:** Proposed (the decisions of the developer are recorded as D-39; the cross-cutting rules still await Akshay)
- **Date:** 2026-10-09
- **Deciders:** Tanmay (stream L, contract owner). Akshay (stream P, consumer) to confirm the open points; review is optional (D-37).
- **Requirements:** IF-2, FR-SES, FR-INS, FR-FLG, FR-HNT, FR-ACH, FR-SCR, FR-DSH, FR-DET, NFR-SEC-03, D-21, D-37, D-39, handoff H-78

## Context
Akshay's dashboards (P-04) must be built against the browser-facing lab API, but IF-2 did not exist: `contracts/api/lab/` was empty, and the documents disagreed on paths (`/api/instances`, `/attempts/ID/flags`) and on who owns hints, reports and attempt routes. Three things needed a decision before the file could be written: how routes are prefixed, what the mock is, and which routes belong to the lab.

## Options considered
1. **Route prefix.** (a) No version, as in the examples of architecture 03 to 05. Simple, but a later incompatible change has no place to go. (b) `/api/v1/` for every route. One prefix for both fragments, the version is visible, and IF-5 already uses `/v1/`. Chosen.
2. **Mock.** (a) Prism, as architecture 07 section 3.1 says. It serves examples from an OpenAPI file with no code, but it is a new dependency, it cannot hold state (a flag result by input, a rate limit, a reset that raises an epoch), and the tool is UNVERIFIED in the architecture (ADR 0012 asks for confirmation). (b) A dependency-free Node fake in the pattern of `fake-orchestrator` and `fake-ingest`. It holds a small state, answers every operation and runs in the existing test setup. Chosen. Cost: it is code we maintain, and it can drift from the file; a conformance test (every answer validated against the OpenAPI response schemas) guards that.
3. **Scope.** (a) Lab and platform routes together. Blocks on Akshay's IF-1 and mixes owners. (b) Lab-owned routes only, using one rule: a route is lab-owned when it reads or changes the tables the lab owns (architecture 07 section 5). Platform routes (login, consent, create-attempt-from-consent, cancel, withdraw, purge, exports, admin, live stream) are listed as handoff rows. Chosen.
4. **Attempt start.** The clock rule is OPEN (OI-22). The route is included and marked pending, with both outcomes written in the open-points table, rather than left out (which would leave the dashboard with no way to start) or fixed (which would decide OI-22).

## Decision
`/api/v1/` for every route; a Node mock with no dependency; lab-owned routes only; the start route pending OI-22. Browser rules are those of architecture 03 (cookie `__Host-vm_session`, CSRF header, Origin check, JSON only, `Cache-Control: private, no-store`). Errors are problem-details bodies (`code`, `message`, `request_id`, `field`). States, access and health are copied from IF-5 and a check fails if they drift. Everything the architecture does not fix (CSRF header name, paging, idempotency, time format, id shapes, error code names) is a proposal in the open-points table, none decided.

## Consequences
- The dashboards can be built now against the mock; the bundle script (P-04's) merges this fragment with IF-1.
- The mock must be kept in step with the file (a conformance test and a checker fail when they differ).
- Placeholder error codes become a breaking rename if the registry (P-02) chooses other names (handoff H-81).
- Open items stay open: OI-14, 15, 21, 22, 23, 24, 25, 26, 27, 38 each have both outcomes recorded in `lab-api.md`.

## Evidence
- Repository sources read in this task: `docs/architecture/03-origins-and-access.md`, `04-data-and-state.md`, `05-key-flows.md`, `07-repo-and-workstreams.md`, the PRD requirements named above, the IF-5 contract and its check, tests and mock (the patterns copied).
- Verified by running: `pnpm run contracts:check` (lab contract: 18 operations, 38 valid and 82 invalid examples, PASS), `apps/api/tests/test_lab_contract.py` (62 tests), `scripts/e2e/lab.e2e.test.mjs` (12 tests). Outputs in `docs/assets/l-05-lab-api/`.
- External standards the design relies on (OpenAPI 3.1 specification, problem details RFC 9457, OWASP CSRF prevention guidance, Prism documentation) were **not read in this session**: UNVERIFIED here. The architecture documents cite their own sources for the cookie and CSRF rules (architecture 03, `[EF-07]`, `[EF-01]`, `[EF-02]`).
