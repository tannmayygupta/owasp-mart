# Repository skeleton and tooling (L-01, story 1.1)

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-01 / local commit, not pushed (early pull request branch) |
| Status | Done, except one open item: CI not yet seen green on a real pull request (branch pushed, pull request not yet opened) |
| Report tag | tooling, tracer bullet, BMAD cycle |

## Requirements covered
LB-1, LB-2 (task L-01); architecture 07 sections 1, 2, 6, 7.7 row 0; decision D-21 (stack versions).

## Summary (plain language, 3-5 lines)
The repository now has the folder layout for all three streams, pinned tool versions, empty pnpm and uv workspaces with lockfiles, CODEOWNERS, a CI workflow, a Compose file with one hardened hello container, and `scripts/dev.mjs` to start it. Docker Desktop on this PC was broken (a half-installed WSL); after repairing WSL it works, and `hello`, `doctor` and the container hardening all pass on this PC. The story went through the full BMAD cycle: story, plan, implementation, thorough review, tests.

## Why
Akshay (P-01) and Sahil (T-01, T-02) cannot start without a layout, pinned tools, CI and a one-command container start (story 1.1).

## What was built
Layout folders with `.gitkeep`; `.node-version`, `.python-version`, `package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `pnpm-lock.yaml`, `uv.lock`; `infra/compose/compose.yaml`; `scripts/dev.mjs`, `scripts/dev.test.mjs` and `scripts/e2e/dev.e2e.test.mjs`; `.github/CODEOWNERS`; `.github/workflows/ci.yml`; README "Developer commands"; `.gitignore` now ignores the generated `_bmad/render/`.

## How it works
`dev.mjs hello`: checks Docker, removes a stale `vulnmart-hello` container, checks port 18080 is free, runs `docker compose --profile hello up -d --wait`, GETs the page, and always runs `down` afterwards. `up <profile>` refuses a profile that has no services yet. `doctor` prints versions with PASS or FAIL and now FAILs when Node's major version or pnpm's version differs from the pin. The hello container runs as a non-root user, with a read-only root, a memory-backed `/tmp`, all capabilities dropped, no-new-privileges, port on 127.0.0.1 only, 64 MB memory, 64 processes and no bind mounts.

## Files changed
See the changelog line; new files, plus edits to `README.md`, `CHANGELOG.md`, `.gitignore`, `docs/traceability.md`.

## Decisions made
- Versions chosen on build day from the registries: Node 24.21.0 (current 24 LTS), pnpm 12.10.1, uv 0.12.23, Python 3.14.8 (locked stack decision D-21; the first draft pinned 3.13.16 by mistake and was corrected), busybox 1.37.0-musl by digest, GitHub Actions by commit SHA (checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.0, setup-uv v10.2.0). No ADR: not a new architecture decision.
- By Tanmay on 2026-10-08: CODEOWNERS handles `@tannmayygupta` (L), `@akshaay29` (P), `@sahillroy` (T); Docker and WSL memory cap 8 GB.

## Tests
All on Tanmay's PC, Docker 29.6.2, outputs in `docs/assets/l-01-repository-skeleton/`:
- `node --test "scripts/*.test.mjs"`: 19 tests, 19 pass (`script-tests-2026-10-08.txt`).
- `node --test "scripts/e2e/*.test.mjs"` against the real Docker engine: 10 tests, 10 pass in 56 s (`e2e-tests-2026-10-08.txt`).
- `node scripts/dev.mjs doctor`: 6 of 6 PASS, exit 0 (`doctor-2026-10-08.txt`).
- `node scripts/dev.mjs hello`: prints `hello`, exit 0, 0 containers left (`hello-2026-10-08.txt`).
- `docker inspect` of the running container: user 65532, read-only root, `CapDrop=[ALL]`, no-new-privileges, no binds, port 127.0.0.1:18080, 64 MB, 64 pids, healthy (`hello-hardening-2026-10-08.txt`).
- `pnpm install --frozen-lockfile`, `uv lock --check`, `docker compose ... config -q`: exit 0. `node scripts/verify-skills.mjs`: OK, 217 files.
- NOT run: CI on a pull request, macOS, Linux, Sahil's PC.

## Evidence
`docs/assets/l-01-repository-skeleton/`; screenshot of the original WSL error is `image.png` (not committed). Review log: Review Triage Log in the plan file; deferred items in `docs/bmad/initiative-lab/deferred-work.md`; QA summary in `docs/bmad/initiative-lab/test-summary-l-01-dev-command/`.

## Problems met and how they were fixed
- **Docker would not start.** Docker Desktop showed "There was a problem with WSL": `wsl.exe --version` failed with "cannot find the file specified". The cause was a half-installed WSL package (2.5.9, files missing). Updated to 2.7.13 with `winget upgrade Microsoft.WSL` (needed an administrator prompt, approved by Tanmay); no restart needed. Hung Docker Desktop processes were stopped and Docker Desktop started again; the engine came up. `.wslconfig` was created with `memory=8GB`.
- `node --test scripts/` fails on Node 24.11 (treats the folder as a module). Used the glob `"scripts/*.test.mjs"` in `package.json`, README and CI instead of the plan's literal command.
- `docker info` exits 0 while printing "Docker Desktop is unable to start", so the first doctor showed Docker running. Fixed by also requiring a version number on stdout.
- Global pnpm 10.4.1 broke when the repo pinned pnpm 12.10.1; fixed with `npm i -g pnpm@12.10.1` on this PC.
- The implementation agent pinned Python 3.13 against the locked decision; corrected to 3.14.8 and re-locked.
- PowerShell added a UTF-8 byte-order mark to several files; stripped, and the `uv`/TOML files are clean.
- Thorough review (4 reviewers) found 8 real problems in the first implementation, all fixed: invalid multi-pattern CODEOWNERS lines (six service paths unowned), doctor did not check the pins, tests did not pin Compose arguments, `up`/`down` untested, hardening unchecked by tests, no command timeouts, a fragile entry guard, and CI jobs without timeouts. Two reviewer claims were wrong and rejected after checking (empty profile behaviour, missing `.gitignore` entries).

## Security notes (vulnerable parts only)
None; no vulnerable code. No secrets in any file.

## Limitations and follow-ups
- Branch `shared-L-01` is pushed. Open the pull request and confirm CI is green; the `compose` job runs `hello` on the GitHub runner and has not been seen yet.
- Docker's data (4.8 GB) was moved to `D:\docker-data\wsl` and `%LOCALAPPDATA%\Docker\wsl` is now a junction to it (copy verified byte for byte, then Docker restarted: the n8n image and its volume are still there and `hello` passes). The old copy is kept as `%LOCALAPPDATA%\Docker\wsl.old-backup` (5 GB on C:) until Tanmay confirms it can be deleted.
- Story risk check: after the merge, Akshay (Mac) and Sahil (Windows) run `node scripts/dev.mjs hello` on their machines and report.
- Deferred (see deferred-work.md): a Windows CI job, pnpm supply-chain settings, CI green and the other machines.
- `image.png` (the Docker error screenshot) is untracked and not committed.
