# VulnMart

A containerized, flag-based, intentionally vulnerable online marketplace for OWASP Top 10 practice and for hiring assessments. Each user gets a private copy of the shop, attacks it, and every exploit is detected and scored automatically.

Built by three developers. Final submission: first week of November 2026.

## Where to start

| You are | Read first |
|---|---|
| Anyone | [initial.md](initial.md) (decisions and open questions), [CLAUDE.md](CLAUDE.md) (working rules) |
| Tanmay (Lab stream) | [docs/dev/dev1-tanmay.md](docs/dev/dev1-tanmay.md) |
| Akshay (Platform stream) | [docs/dev/dev2-akshay.md](docs/dev/dev2-akshay.md) |
| Sahil (Target stream) | [docs/dev/dev3-sahil.md](docs/dev/dev3-sahil.md) |

## Folder map

- `initial.md`: source of truth for decisions. `CLAUDE.md`: rules for Claude Code. `CHANGELOG.md`: what changed.
- `docs/`: everything written down (see [docs/README.md](docs/README.md)): requirements, architecture, research, decisions, task lists, dev-log.
- `.claude/` and `_bmad/`: the BMAD workflow skills and runtime that Claude Code uses. Do not edit or update them without the team agreeing; `node scripts/verify-skills.mjs` checks they are unchanged.
- `scripts/`: the documentation commit gate and the skills verifier. `.githooks/`: the git backstop for the gate (enable once per clone with `git config core.hooksPath .githooks`).

## Developer commands

Needs Node (version in `.node-version`), pnpm and uv (versions pinned in `package.json` and CI), and Docker Desktop running.

| Command | What it does |
|---|---|
| `node scripts/dev.mjs doctor` | Prints tool versions with PASS or FAIL |
| `node scripts/dev.mjs hello` | Starts a hardened hello container, checks it, removes it |
| `node scripts/dev.mjs up <profile...>` | Starts Compose profiles `platform`, `web`, `lab`, `mocks` (`lab` holds only the Docker socket proxy of story 4.2, `mocks` is empty until a later story) |
| `node scripts/dev.mjs up platform web` | Starts the platform stack: Postgres, Valkey, Mailpit, the API and the dashboards dev server. Open <http://127.0.0.1:3000> (page shows API, Postgres and Valkey health), the API is on port 8000 and the Mailpit page on 8025 (all loopback only). First start builds the images and installs the dashboards' packages, so allow a few minutes. `up` does not rebuild an existing image: after changing API code run `docker compose -f infra/compose/compose.yaml --profile platform build api` (dashboards code reloads by itself) |
| `uv run --directory apps/api pytest` | Runs the API unit tests (needs `uv`; no Docker) |
| `docker compose -f infra/compose/compose.yaml --profile platform --profile web down -v` | Resets the platform stack: `dev.mjs down` keeps the named volumes (database data, the dashboards' `node_modules` and `.next`), so use this when you change the dev database password or want a clean database |
| `node scripts/dev.mjs down` | Stops and removes the project's containers |
| `pnpm run contracts:check` | Validates all three contracts: instance (IF-6), instance events (IF-4) and orchestrator (IF-5); needs `pnpm install` and `uv` once |
| `uv run --package vulnmart-api pytest` | Runs the Python tests: the orchestrator API (IF-5) protocol suite against `FakeInstanceHost` and against the HTTP client plus the fake orchestrator `contracts/mocks/fake-orchestrator/server.mjs` (needs Node and uv) |
| `pnpm run events:check` | Validates only the instance event contract (IF-4, `contracts/events/`) |
| `node contracts/mocks/fake-ingest/server.mjs --key <test key> --port <n>` | Starts the fake ingest (stand-in for the real one; answers 202, 200, 401, 413, 422; use a throwaway key, never a real one) |
| `pnpm run catalog:check` | Validates the challenge catalogue (IF-7): the 11 stubs against the schema and the semantic rules (needs `pnpm install` once) |
| `node --test "scripts/*.test.mjs"` | Runs the script tests (no Docker needed; needs `pnpm install` once) |
| `pnpm run test:e2e` | Runs `node --test --test-concurrency=1 "scripts/e2e/*.test.mjs"`, the end-to-end tests, one file at a time: real Docker engine and contract copies (a few minutes; needs ports 3000, 8000 and 8025 free; the contract tests also install dependencies in a temporary copy) |

Application code (platform, lab and target) is not written yet; it starts with the Sprint 1 tasks.
