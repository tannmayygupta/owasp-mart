- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Add an automated browser-level check that the dashboards page hydrates and shows the health result (Playwright, with the dashboards skeleton).
  evidence: Story 1.1 shipped with the page stuck on "Checking the API..." because Next 16 blocked dev resources from 127.0.0.1; every non-browser check (HTTP, e2e) passed. Found only by a real-browser check and fixed with allowedDevOrigins. A guard belongs in story 1.7 (dashboards skeleton).
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Add a CI check that apps/web/pnpm-lock.yaml and the root pnpm-lock.yaml do not drift apart.
  evidence: The dev image installs from the app's own lockfile (as apps/shop does) while CI installs from the root lockfile; two sources of truth for the same dependencies.
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Make `node scripts/dev.mjs up web` (without platform) fail with a clear message instead of Compose's "depends on undefined service" error.
  evidence: The web service depends on api (profile platform). README says to start both; a lone `up web` prints Compose's raw error. Low impact; dev.mjs is stream L's file, so raise it with Tanmay.
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Check the web dev container on a Linux or macOS host, where the bind-mounted source is owned by a host user other than uid 65532.
  evidence: Verified on Windows only (the developer uses no Mac). Next may fail to write next-env.d.ts or tsconfig.json into a source folder it does not own. Unverified; would be medium for a Linux or Mac developer.

## Deferred from: code review of story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan (2026-10-11)

- The real Postgres and Valkey checks, the `/api` rewrite and both Dockerfiles are verified only by `scripts/e2e/platform-stack.e2e.test.mjs`, which no CI workflow runs; CI also builds no image and does not typecheck the web app. Would be medium. Settle by a CI job that runs `pnpm run test:e2e` (stream L owns the CI shape).
- No automated browser-level test that the page hydrates (see the first entry above); to be added with story 1.7.
- Two lockfiles for the web app can drift (see above).
- `up web` without `platform` fails with Compose's raw error (see above).

## Deferred from: code review of story-error-registry-and-problem-details-format-if-8-plan (2026-10-11)

- The end-to-end test (which proves the API image and the web-origin pass-through of error bodies) is not run in CI; only the image build is (added in this review). Would be medium. Settle with a CI job that runs `pnpm run test:e2e`. Source plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-error-registry-and-problem-details-format-if-8-plan.md`.
- Nothing reads the instance contract's exit-code table or stream L's contracts to compare with the registry: the registry matches them today by construction (seeded 2026-10-11) and can drift. Settle with a check that parses `contracts/instance/instance-contract.md` section 5 and, once stream L's contracts are merged, their code lists.
- Registry gaps: no generic `REQ-RATE-LIMITED` (429), `REQ-UNAVAILABLE` (503), `REQ-TIMEOUT`, `AUTH-FORBIDDEN` (403 for a signed-in user) or sign-in failure code, and `retryable` is in the registry but not in the body (no `Retry-After` convention). Add them with the stories that need them (accounts, P-11 and P-12); each is an additive change.
- The generated TypeScript file is not type-checked in CI (it was checked once with `tsc --strict`, exit 0). Add when `apps/web` imports `@vulnmart/ts-client`.

## Deferred from: code review of story-domain-event-schema-if-3-with-fixtures-and-replay-script-plan (2026-10-11)

- No mapping from orchestrator infrastructure faults (IF-4 `fault_class` and `detail_code`) to an `INST-*` registry code: only `INST-HEALTH-TIMEOUT` and the injector codes exist. Needs stream L's list of fault classes; add the codes to the registry and a fixture when L defines them. Source plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-domain-event-schema-if-3-with-fixtures-and-replay-script-plan.md`.
- The H-22 decision (64-bit `seq`, reserved range, `infrastructure_fault` written by the orchestrator) is recorded in HANDOFFS, the IF-3 README and the changelog, but IF-4 and IF-5 text and schemas (stream L's) do not say it yet; they change in their own story.
- The replay script has its own hub and consumer and cannot be pointed at another one; a `--url` mode to drive the real hub is a follow-up for P-22. No code resolves an audience from an attempt yet (the relay, P-05 and P-22); the fixtures supply the resolved audiences and the validator compares them with the table.
- Streams are not size-limited in the contract (trim age or length, connection caps, slow consumers): decided with the hub in P-22 and spike S-2.

## Deferred from: code review of story-platform-and-lab-api-fragments-bundle-mock-and-generated-cli-plan (2026-10-11)

- Mock lab half: lab operations are proxied to the fake lab and tested only for reachability; a bundle-level comparison with the bundle's lab examples is a later hardening (stream L's `test_lab_contract.py` covers the fake lab against IF-2).
- Mock parameter validation: path, query and header parameters are not validated (`limit=1000` gives 200, not 422); add when P-07 needs a failure path.
- IF-1 has no account-deletion or email-change route; later stories (FR-PRV, P-25).
- Client has no `/live` helper (reconnect, `Last-Event-ID`, `stream.resync` then snapshot); write with the dashboards (P-07).
- Client does not throw when an authenticated write has no CSRF token; a dashboards decision (P-07).

- Decision on paging (open point 15): no cursor for the sprint-2 slice; add additively with the dashboards story that needs it.
