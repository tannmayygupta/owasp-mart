---
title: 'Platform stack runs end to end locally (tracer bullet)'
type: 'feature'
ticket: '1'
created: '2026-10-11'
status: 'built'
baseline_revision: '653d6f8b7c24b1eda571fc102c308b98eada0d91'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick-inline-self-review']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/03-origins-and-access.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `platform` and `web` Compose profiles are empty and `apps/api` and `apps/web` have no code, so nothing proves that dashboards, API, Postgres and Valkey work together on a developer machine. Every later platform story builds on that path (PB-7, PB-8).

**Approach:** Add the thinnest working path: a FastAPI app with one tracer endpoint that checks Postgres and Valkey, a Next.js page that shows that result through a same-origin `/api/*` rewrite, and the Compose services (Postgres 18, Valkey, Mailpit, API, web) started by the existing `node scripts/dev.mjs up platform web`. The web service runs the Next.js dev server with the source mounted. Verify on a real Docker engine on the developer's Windows PC.

## Boundaries & Constraints

**Always:** Versions follow D-21 (FastAPI, Next.js 16, PostgreSQL 18, Python 3.14.8, Node 24.21.0 from `.node-version`) and are pinned exactly, images by digest. Images run non-root with `no-new-privileges`, memory and pids limits; only the web, API and Mailpit UI ports are published, on `127.0.0.1`; Postgres and Valkey are not published. The health endpoint never returns error text or internals (NFR-SEC-03). Compose changes are additive and stay inside the `platform` and `web` profiles. Real command output only.

**Decisions (developer, 2026-10-11):** (1) Akshay uses Windows only, so PB-8 is verified on his Windows PC, not a Mac; the story may close after that check and his confirmation, and the tracker records the change. (2) The web profile is a dev server with the source bind-mounted; `node_modules` and `.next` live in named volumes and file watching uses polling (Windows bind mounts). (3) psycopg 3 with binary wheels, valkey-py, TypeScript 5.x (not 7.x) and the pinned images in the Code Map are confirmed. (4) The local Postgres password is a fixed, clearly named dev-only value in Compose; Postgres is never published to the host.

**Never:** No kernel, settings, Alembic or migrations (story 1.6). No origin-secret header, no-store or security headers (story 1.7). No worker, ingest, live, scheduler, Caddy or Dramatiq. No Vercel, auth or sessions. No edits to other streams' code beyond the additive Compose block. No real secret in any file. No new architecture decision.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthy stack | `GET /api/healthz` through the web origin | 200 `{"status":"ok","postgres":"ok","valkey":"ok"}` | None |
| Postgres down | API running, Postgres unreachable | 503 `{"status":"degraded","postgres":"down","valkey":"ok"}` | No exception text in the body |
| Valkey down | API running, Valkey unreachable | 503 with `"valkey":"down"` | Same |
| Slow dependency | A check exceeds 2 s | Counted as `down`; the request still returns | Timeout, no hang |
| Docker engine off | `node scripts/dev.mjs up platform web` | Existing "Docker is not running" message, exit 1 | Already handled by `dev.mjs` |
| Cold start order | `up` from nothing | API starts only after Postgres and Valkey are healthy | Compose `depends_on: service_healthy` |

</frozen-after-approval>

## Code Map

- `infra/compose/compose.yaml` -- only the `hello` service exists; the header comment says later stories fill `platform` and `web`. Add the services here; follow the hello hardening pattern. Owned by L (`/infra/`): the PR needs Tanmay's approval.
- `scripts/dev.mjs` -- `up <profile...>` already works once services exist; do not edit (Tanmay's `sprint-1-tanmay` also edits it). `scripts/e2e/dev.e2e.test.mjs` is the pattern for the real-Docker test.
- `apps/shop/Dockerfile` -- precedent for pinned-digest, non-root, multi-stage images and the pnpm 12.10.1 corepack workaround; reuse the approach.
- `pyproject.toml` (root) -- `members = []`; add `apps/api`. Tanmay's branch also edits this file: keep the change to that one line.
- `pnpm-workspace.yaml` -- already includes `apps/*`, so `apps/web` joins automatically; `pnpm-lock.yaml` must be updated (CI uses `--frozen-lockfile`).
- `.github/workflows/ci.yml` -- add an `api` job (`uv sync --frozen`, `pytest`), SHA-pinned actions as in existing jobs.
- `CODEOWNERS`: `/apps/web/` is mine; `/apps/api/` falls under the default owners; `kernel/` and `ports/` stay empty.
- Verified on the registries 2026-10-11: FastAPI 0.143.0, uvicorn 0.54.0, psycopg 3.3.6 (cp314 wheels exist), valkey-py 6.1.1, Next 16.4.0, React 19.3.0, postgres 18.6-trixie, valkey/valkey 9.0.6-alpine3.24 (9.2 is still RC), mailpit v1.31.5, python 3.14.8-slim-trixie.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/pyproject.toml`, `apps/api/src/vulnmart/main.py` -- FastAPI app, `GET /healthz` checking Postgres (`SELECT 1`) and Valkey (`PING`), 2 s timeouts, dependency checks injectable for tests; root `pyproject.toml` and `uv.lock` updated -- the tracer endpoint.
- [ ] `apps/api/tests/test_healthz.py` -- pytest for ok, Postgres down, Valkey down, timeout, and no leaked error text -- the I/O matrix.
- [ ] `apps/api/Dockerfile`, `.dockerignore` -- multi-stage, digest-pinned, uid 65532, healthcheck.
- [ ] `apps/web/package.json`, `next.config.mjs`, `app/layout.*`, `app/page.*`, `Dockerfile`, `.dockerignore` -- Next.js page fetching `/api/healthz` with a rewrite to the API; dev-server image; own lockfile as in `apps/shop`.
- [ ] `infra/compose/compose.yaml` -- `postgres`, `valkey`, `mailpit`, `api` (profile `platform`), `web` (profile `web`, source mounted, named volumes for `node_modules` and `.next`), health checks, named volume for Postgres data.
- [ ] `scripts/e2e/platform-stack.e2e.test.mjs` -- starts the stack, checks `/api/healthz` through port 3000, stops it.
- [ ] `.github/workflows/ci.yml`, `README.md` -- API test job; document `up platform web`.

**Acceptance Criteria:**
- Given Docker is running, when `node scripts/dev.mjs up platform web` runs, then five services are healthy and the command exits 0.
- Given the stack is up, when a browser opens `http://127.0.0.1:3000`, then the page shows API, Postgres and Valkey as ok, and the browser makes requests only to port 3000.
- Given the stack is up, when `node scripts/dev.mjs down` runs, then no `vulnmart` platform container remains.
- Given a clean checkout, when `pnpm install --frozen-lockfile` and `uv lock --check` run, then both pass; `node scripts/dev.mjs doctor` shows all PASS.

## Implementation Notes

- An implementer subagent was started and wrote the API, the web skeleton and the first Dockerfiles (15:14 to 15:18) before the developer interrupted it; it did not finish. The rest (web image, Compose services, e2e test, CI, README) and the review were done directly in the main session, after reading and checking what it had written.
- `httpx2` in the API dev dependencies is the Pydantic organisation's successor to httpx and is what Starlette 1.7's test extra lists; not a typo.
- Found only by running it for real, all fixed: Mailpit needs a writable `/tmp` (it keeps a temporary SQLite file there) so it got a small tmpfs; Next 16 blocks dev resources from `127.0.0.1`, which left the page on "Checking the API..." until `allowedDevOrigins: ['127.0.0.1']` was set in `apps/web/next.config.mjs`; the root `pnpm-lock.yaml` had no `apps/web` entry so `pnpm install --frozen-lockfile` failed (regenerated); `scripts/dev.test.mjs` asserted that the whole Compose file has no `volumes:`, now scoped to the hello service (Tanmay's file: the pull request needs his approval).
- `package.json` `test:e2e` now runs `--test-concurrency=1`: the existing and new e2e files share one Compose project and each calls `down`, so they must not run in parallel.
- Global pnpm on this PC was broken (the same fault as Tanmay's) and was reinstalled with `npm i -g pnpm@12.10.1`.
- Docker Desktop was off at the start of the session and was started by hand.
- Decision recorded by the developer: PB-8 is verified on his Windows PC, not a Mac.

## Plan Change Log

## Review Triage Log

Lens: quick, run inline by the main session (no subagent: the developer declined one). This is a self-review, not an independent one; an independent `bmad-code-review` is the next step in the task cycle.

| # | Finding | Verdict | Route | Evidence |
|---|---------|---------|-------|----------|
| 1 | Mailpit exits 1 on a read-only root | high | patch (done) | Container log: `open /tmp/mailpit-....db: read-only file system`; fixed with a tmpfs, all five services healthy |
| 2 | Page never hydrates on `127.0.0.1` (dev resources blocked) | high | patch (done) | Dev server log `Blocked cross-origin request to /_next/hmr`; after `allowedDevOrigins` the browser shows API, Postgres and Valkey ok |
| 3 | Root lockfile lacks `apps/web`, so CI frozen install fails | high | patch (done) | `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`; regenerated, frozen install exits 0 |
| 4 | `dev.test.mjs` fails on the whole-file `volumes:` assertion | medium | patch (done) | 1 failing script test; scoped to the hello block, 53 of 53 pass |
| 5 | No automated browser-level check of the page | medium | defer | Bug 2 passed every HTTP and e2e check; recorded in deferred-work.md for story 1.7 |
| 6 | Two lockfiles for the web app can drift | low | defer | Same pattern as apps/shop; recorded in deferred-work.md |
| 7 | `up web` alone gives Compose's raw error | low | defer | dev.mjs is Tanmay's file; recorded |
| 8 | Bind-mount write access on Linux or macOS hosts | maybe-false (would be medium) | defer | Needs a Linux or Mac host to settle; recorded |
| 9 | Fixed dev database password visible in `docker inspect` | low | accepted | Developer's decision 4; Postgres is not published and the value is named dev-only |

## Design Notes

The endpoint is named `/healthz` and returns dependency status in one payload on purpose: story 1.6 splits it into health, readiness and version endpoints with request IDs and logs, so keep this one small and replaceable.

## Verification

**Commands:**
- `uv run --directory apps/api pytest` -- expected: all tests pass
- `node scripts/dev.mjs doctor` -- expected: all PASS, exit 0
- `node scripts/dev.mjs up platform web` -- expected: services healthy, exit 0
- `curl http://127.0.0.1:3000/api/healthz` -- expected: 200 and the three `ok` values
- `node --test "scripts/e2e/platform-stack.e2e.test.mjs"` -- expected: pass against the real engine
- `docker compose -f infra/compose/compose.yaml config -q` and `node scripts/verify-skills.mjs` -- expected: exit 0

**Manual checks:**
- Open the page in a browser, confirm "ok" for all three, and in the network tab confirm the call goes to `/api/healthz` on port 3000.

## Code Review

### 2026-10-11 Code review complete. 0 `decision-needed`, 7 `patch`, 4 `defer`, 13 rejected.

Four independent reviewers (blind-hunter, edge-case-hunter, verification-gap, intent-alignment) read a 947-line diff of 22 files (generated lockfiles and saved test output excluded). Verdicts were rendered by the main session, not the reviewers.

- [x] [Review][Patch] `create_app({})` silently uses the real Postgres and Valkey checks (`checks or {...}`); use `is not None` and add a test [apps/api/src/vulnmart/main.py]
- [x] [Review][Patch] `connect_timeout=int(CHECK_TIMEOUT_SECONDS)` truncates a sub-second value to 0 (no timeout in libpq); use `max(1, ceil(...))` [apps/api/src/vulnmart/main.py]
- [x] [Review][Patch] The page has no fetch timeout (a hung proxy leaves "Checking the API..." forever), casts the body without checking the three fields, and has a redundant ternary [apps/web/app/page.tsx]
- [x] [Review][Patch] The "Started:" assertion uses an unanchored `new RegExp(service)`, so `api` and `web` prove nothing; the per-service health checks cover it but the assertion should be exact [scripts/e2e/platform-stack.e2e.test.mjs]
- [x] [Review][Patch] No Docker-free test of the new services' hardening, loopback-only ports and unpublished Postgres and Valkey; only the e2e (not run in CI) checks them, so a weakened service could merge green [scripts/dev.test.mjs]
- [x] [Review][Patch] The dev database password is written twice (Postgres environment and the API DSN); one source avoids drift [infra/compose/compose.yaml]
- [x] [Review][Patch] README does not say that the named volumes survive `down` or that the Postgres password only applies on first initialisation; document the reset command [README.md]
- [x] [Review][Defer] The real Postgres and Valkey checks, the `/api` rewrite and both Dockerfiles are verified only by the e2e test, which no CI workflow runs; CI also builds no image and does not typecheck the web app [.github/workflows/ci.yml] — deferred: needs Docker in CI (stream L owns CI shape); would be medium. Settle by adding a CI job that runs `pnpm run test:e2e`.
- [x] [Review][Defer] No automated browser-level test that the page hydrates and shows the three values; the e2e page check passes on the server-rendered title alone [apps/web/app/page.tsx] — deferred: Playwright arrives with the dashboards skeleton (story 1.7); already recorded.
- [x] [Review][Defer] Two lockfiles for the web app (root and apps/web) can drift [apps/web/Dockerfile] — deferred: same pattern as apps/shop; already recorded.
- [x] [Review][Defer] `up web` without `platform` fails with Compose's raw "depends on undefined service" error [infra/compose/compose.yaml] — deferred: dev.mjs is stream L's file; already recorded.

**Rejected**
- False: lockfiles missing from the diff: excluded from the review diff by me; both are in the tree and frozen installs pass (saved output).
- False: `httpx2` is a typo or supply-chain risk: it is the Pydantic organisation's package, listed in Starlette 1.7's test extra.
- False: port test would miss an extra IPv6 binding: it asserts every binding's `HostIp` is `127.0.0.1`, so an extra `::1` binding fails it.
- False: no evidence of a Windows run: the saved output is in `docs/assets/p-01-platform-stack/`, which the review diff excluded.
- Low, not worth fixing: constant-equals-itself timeout test; `# noqa` without a linter; naming and timing inconsistencies in comments; Node bookworm versus Python trixie (the Node digest is reused from apps/shop); `deferred-work.md` format (mandated by the workflow); empty or trailing-slash `API_ORIGIN` (Compose sets it); `.gitignore` for mount-point folders (the root rules cover directories); an assertion in a `finally` hiding the first failure (only when a restart also fails); port probe on `127.0.0.1` versus `0.0.0.0` (Docker reports the conflict clearly); thin failure logging (story 1.6 adds structured logs).
- Accepted by decision: the writable source mount and install on start (developer's decision 2, dev server); `/healthz` unauthenticated and doing two jobs (documented in Design Notes, replaced by story 1.6).
