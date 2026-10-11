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

