# 0070. Browser tests run the production build of the dashboards against the real API app on a throw-away database

- **Status:** Accepted (the leader asked for real browser tests on 2026-10-21; the choices below are Claude's, to be reviewed in the pull request)
- **Date:** 2026-10-21
- **Deciders:** the leader, with Claude Code
- **Requirements:** FR-DSH-01, FR-DSH-04, FR-NTF-04, audit F-14 and section 7 (no browser test had run the learner or candidate flow)

## Context
The dashboards were tested only with Node unit tests and, on the real stack, with HTTP calls. Nothing drove a browser through sign-up, a sequenced practice run, an invite, consent, the clock, hints, submit, hidden results and the recruiter's release. The audit found that the sequenced mode broke the dashboards without any test noticing.

## Options considered
1. **Playwright, real API app in a Python runner (chosen).** The runner (`apps/api/tests/e2e_web_server.py`) builds the real FastAPI app with the same services the API tests use, on a SQLite file, the in-memory fake instance host and the real (offset) clock, with a seeded company, recruiter and invited candidates. Nothing of the API routes is stubbed. The browser talks to `next start` of the production build, so the production CSP is in force; a test fails on any CSP violation or uncaught page error.
2. A scripted fake lab (`contracts/mocks/fake-lab`) behind the dashboards: faster, but it is a mock of the contract, not the behaviour, so it would not have caught F-14-type drift between the real lab and the page.
3. The full Docker Compose stack: closest to production but needs Docker, Postgres and the orchestrator, and cannot run on a plain CI runner quickly.
4. Cypress or Selenium: no advantage here; Playwright runs on Windows and the GitHub ubuntu runner, can use an installed Chrome (`E2E_BROWSER_CHANNEL=chrome`), and has first-class auto-waiting.

## Decision
- Playwright 1.63.0 (older than six weeks when chosen), in its own folder `tests/web-e2e/` with its own lockfile, outside the pnpm workspace. Reason found while building: adding it to the workspace made pnpm resolve `next` with the optional peer `@playwright/test` in the root lockfile, which made the root and the `apps/web` lockfile differ and broke `scripts/web-lockfile-sync.test.mjs` (rule of story 1.9). A separate folder leaves both lockfiles of the dashboards untouched.
- `pnpm --filter @vulnmart/web test:e2e` installs that folder (`--ignore-workspace --frozen-lockfile`) and runs the suite; Playwright's `webServer` starts the API runner and `next build && next start`.
- Test-only hooks live in the runner under `/_e2e` and are never reachable through the dashboards' proxy (it forwards `/api/*` only): the mail token of a sign-up, the activity a player's requests would give, the flag of an instance (made from the process's random keys), and a clock advance (the lab's own `OffsetClock`, so the page's skew correction is really exercised).
- The CI job is proposed in `docs/runbooks/web-e2e.md`, not added to `.github/workflows`.

## Consequences
- Easier: a change to the sequenced mode, the mode split or the candidate rules that breaks the pages now fails a test.
- Harder: the suite builds the dashboards (about 30 s) and runs about one minute; it needs `uv` and Node.
- The runner replicates the service wiring of the API tests; when `create_app` gains a service, the runner may need it too.
- Watch: the API says `hints_enabled: false` for every company attempt (`lab/api.py hints_enabled` placeholder), so the candidate hint flow cannot be exercised end to end yet; the test asserts the page follows the attempt.

## Evidence
Real results are in the dev-log `docs/dev-log/2026-10-21-tannmayygupta-learner-candidate-web-and-browser-tests.md` and the screenshots in `docs/assets/wp-e-learner-candidate-web/`.