# Platform stack runs end to end locally (P-01, story 1.1)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay / local commit, not pushed |
| Status | Done on the developer's Windows PC; pull request not yet opened, so not merged and CI not yet seen |
| Report tag | tooling, tracer bullet, BMAD cycle |

## Requirements covered
PB-7 (platform Compose profile starts with one command), PB-8 (developer environment verified; on the developer's Windows PC, see Decisions). Related: NFR-POR-03, Q-24, architecture 07 sections 1, 6 and 7.7, architecture 03 section 1 (same-origin path), D-21.

## Summary (plain language, 3-5 lines)
`node scripts/dev.mjs up platform web` now starts Postgres 18, Valkey, Mailpit, the API and the dashboards dev server. A page at http://127.0.0.1:3000 shows the health of the API, Postgres and Valkey, fetched through a same-origin `/api/*` rewrite. It is the thinnest working path through every layer, so later platform stories can build on it. Verified on a real Docker engine and in a real browser engine (headless Edge).

## Why
Nothing proved that the dashboards, API, database and cache work together on a developer machine, and every later platform story needs that path (story 1.1 of `epic-platform-baseline`; P-02 to P-08 wait on it).

## What was built
- `apps/api`: a FastAPI app with one endpoint, `GET /healthz`. It runs `SELECT 1` on Postgres and `PING` on Valkey (2 s limit each) and answers 200 `{"status":"ok","postgres":"ok","valkey":"ok"}`, or 503 with `"down"` for the part that failed. It never returns error text. A uv workspace member (psycopg 3, valkey-py).
- `apps/web`: a Next.js 16 page (TypeScript 5.9) that calls `/api/healthz` and shows the three values; `next.config.mjs` rewrites `/api/*` to the API.
- `infra/compose/compose.yaml`: services `postgres`, `valkey`, `mailpit`, `api` (profile `platform`) and `web` (profile `web`), images pinned by digest, non-root, read-only root, all capabilities dropped, memory and pids limits, ports only on 127.0.0.1 and none for Postgres and Valkey.
- Tests: 10 API unit tests, a Docker-free static test of the new services' hardening and ports, a 9-test end-to-end test on a real engine, and a CI `api` job.

## How it works
Browser -> web (port 3000) -> Next.js rewrite -> API (port 8000, on the Compose network) -> Postgres and Valkey. The API starts only after Postgres and Valkey are healthy. The web service runs the Next.js dev server with the source bind-mounted; `node_modules` and `.next` live in named volumes and file watching polls (Windows bind mounts are slow). The dev database password is one fixed, clearly named development value used by Postgres and the API; Postgres is not reachable from the host.

## Files changed
- `apps/api/` (new): `pyproject.toml`, `src/vulnmart/main.py`, `tests/test_healthz.py`, `Dockerfile`, `Dockerfile.dockerignore`
- `apps/web/` (new): `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.mjs`, `app/layout.tsx`, `app/page.tsx`, `Dockerfile`, `.dockerignore`, `.gitignore`
- `infra/compose/compose.yaml`: the five services and three named volumes (stream L's file, needs Tanmay's approval)
- `scripts/e2e/platform-stack.e2e.test.mjs` (new); `scripts/dev.test.mjs`: the hello test is scoped to the hello service and a static test for the new services was added (stream L's file)
- `package.json` (`test:e2e` runs one file at a time), `pyproject.toml` (workspace member), `pnpm-lock.yaml`, `uv.lock`, `.github/workflows/ci.yml` (`api` job and a platform/web config check), `README.md`
- `docs/bmad/initiative-platform/`: story plan, epic decision lines, `deferred-work.md`

## Decisions made
No new architecture decision, so no ADR. Choices made on the build day, all from the registries checked 2026-10-11: FastAPI 0.143.0, uvicorn 0.54.0, psycopg 3.3.6, valkey-py 6.1.1, Next.js 16.4.0, React 19.3.0, TypeScript 5.9.3 (not 7.x, whose Next.js support was not confirmed), postgres 18.6-trixie, valkey 9.0.6-alpine (9.2 is still a release candidate), mailpit v1.31.5, python 3.14.8-slim-trixie, node 24.21.0.
By the developer on 2026-10-11: (1) he uses Windows only, so PB-8 is verified on his Windows PC, not a Mac; (2) the web profile is a dev server with the source mounted; (3) the library and image choices above; (4) a fixed development-only database password with Postgres not published.

## Tests
All on the developer's Windows 11 PC, Docker 28.5.1, Node 24.11.0, uv 0.12.23, pnpm 12.10.1. Outputs in `docs/assets/p-01-platform-stack/`.
- `uv run --frozen --package vulnmart-api pytest apps/api -v`: 10 passed.
- `node --test "scripts/*.test.mjs"`: 54 tests, 54 pass. The new static test was also run against three deliberately weakened Compose files (mailpit on all interfaces, Postgres publishing a port, web without `read_only`) and failed each time.
- `node --test "apps/*/test/*.test.mjs"`: 55 pass.
- `pnpm run test:e2e` (serial, real Docker): 26 tests, 26 pass; of these 9 are the new platform stack test (five healthy services, health through the web origin, loopback-only ports, hardening, Postgres down and Valkey down give 503 and recover, `down` leaves nothing).
- Real browser engine (headless Edge, DevTools protocol): page text "API: ok, Postgres: ok, Valkey: ok"; the only network host contacted was 127.0.0.1:3000.
- `pnpm install --frozen-lockfile` (root and `apps/web --ignore-workspace`), `uv lock --check`, `pnpm --dir apps/web exec tsc --noEmit`, `docker compose ... config -q`, `node scripts/verify-skills.mjs` (217 files): all exit 0. `node scripts/dev.mjs doctor`: 6 of 6 PASS.
- NOT run: CI on a pull request, Linux or macOS hosts, Sahil's and Tanmay's machines.
- Traceability rows: PB-7, PB-8 in `docs/traceability.md`.

## Evidence
`docs/assets/p-01-platform-stack/` (doctor, pytest, script tests, app tests, end-to-end run, browser check, compose images, frozen installs, typecheck, skills check). Review log: Review Triage Log and Code Review in the plan file; deferred items in `docs/bmad/initiative-platform/deferred-work.md`.

## Problems met and how they were fixed
- Docker Desktop was not running at the start; started it by hand. Global pnpm was broken (the same fault as on Tanmay's PC); reinstalled with `npm i -g pnpm@12.10.1`.
- A first implementer run was interrupted by the developer after it had written the API and web skeleton; the rest was done directly after checking what it had written.
- Mailpit exited 1: it keeps a temporary SQLite file in `/tmp`, which the read-only root blocked. Fixed with a small memory-backed `/tmp`.
- The page stayed on "Checking the API...": Next 16 blocks dev resources (hot reload) from the `127.0.0.1` origin. Every HTTP-level check had passed; only the browser check found it. Fixed with `allowedDevOrigins: ['127.0.0.1']`.
- The root `pnpm-lock.yaml` had no entry for `apps/web`, so CI's frozen install would have failed; regenerated.
- An existing hello test asserted that the whole Compose file has no `volumes:`; scoped it to the hello service.
- A static test I wrote first failed on the unmodified file because `\s` loses its backslash in a plain JavaScript template literal; fixed with `String.raw`, then mutation-tested.
- Independent code review (4 reviewers): 7 small patches applied (empty-checks fallback, connect timeout truncating to 0, page fetch timeout and field validation, e2e regex, a Docker-free hardening test, one source for the dev password, README reset note), 4 items deferred, 13 rejected (details in the plan).

## Security notes (vulnerable parts only)
None; no vulnerable code. No secrets or flags in any file. The development database password is a named, fixed development value, and Postgres is not published to the host.

## Limitations and follow-ups
- Not merged: the pull request still needs to be opened and approved. It edits Tanmay's `/infra/` Compose file and `scripts/dev.test.mjs`; his `sprint-1-tanmay` branch also edits `pyproject.toml` and `scripts/dev.mjs`, so expect small merge conflicts. CI has not been seen green.
- The end-to-end test and the Dockerfiles are not run in CI; the page's hydration has no automated browser test (add with story 1.7); two lockfiles for the web app can drift; `up web` alone gives Compose's raw error; the web dev container is verified on Windows only. All in `docs/bmad/initiative-platform/deferred-work.md`.
- `up` does not rebuild an existing image: after changing API code, rebuild it (README).
- The Docker volumes (database, `node_modules`, `.next`) survive `down`; the README shows how to reset them.
