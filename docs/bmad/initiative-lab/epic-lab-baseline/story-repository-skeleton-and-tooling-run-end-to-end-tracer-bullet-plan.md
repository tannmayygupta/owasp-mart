---
title: 'Repository skeleton and tooling run end to end (tracer bullet)'
type: 'chore'
ticket: '1'
created: '2026-10-08'
status: done
baseline_revision: '10d5b52ea1ff223f7a362dcc3650eacdf0457176'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
assignee: "tannmayygupta"
---

<frozen-after-approval reason="human-owned intent â€” do not modify unless human renegotiates">

## Intent

**Problem:** The repository holds only documents. Akshay (P-01) and Sahil (T-01, T-02) cannot start, because there is no workspace layout, no pinned tooling, no CI, no CODEOWNERS and no one-command way to start containers on Windows and macOS.

**Approach:** Add the monorepo skeleton from architecture section 1, pin the tools from the registries on build day, add a minimal CI that runs green on a pull request, and add `scripts/dev.mjs` with a `hello` command that starts one hardened container. Verify Docker on Tanmay's PC (LB-2).

## Boundaries & Constraints

**Always:** Work on Windows, macOS and Linux with Node built-ins only; LF line endings; pin Node, pnpm, Python, uv and GitHub Actions to exact versions (Actions by commit SHA with the version in a comment); run containers hardened (non-root, read-only root, all capabilities dropped, no-new-privileges, port on 127.0.0.1 only, no host mounts); no secrets in any file.

**Never:** Application code, real contracts, mocks or stubs (L-02 to L-07 own them); branch-protection settings and the contract tag (L-09); arm64 image builds (L-12); changes to `scripts/check-docs.mjs`, `scripts/verify-skills.mjs`, `.claude/skills/**` or `_bmad/**`; the `latest` tag anywhere.

**Decisions (Tanmay, 2026-10-08):** CODEOWNERS handles are `@tannmayygupta` (Tanmay, stream L), `@akshaay29` (Akshay, stream P) and `@sahillroy` (Sahil, stream T). Docker and WSL memory is capped at 8 GB in `%USERPROFILE%\.wslconfig`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hello works | Docker running, port 18080 free | Container starts, reports healthy, GET returns 200 with `hello`, container removed, exit 0 | No error expected |
| Docker not running | Docker daemon stopped | No container created | Exit 1 with a message that says how to start Docker Desktop |
| Port busy | Something listens on 18080 | No container created | Exit 1 naming the port |
| Stale container | Hello container from an earlier run exists | Removed first, then a fresh start | No error expected |
| Doctor | Any machine | Prints Node, pnpm, uv, Docker, Compose versions with PASS or FAIL | Exit 1 when any check fails |

</frozen-after-approval>

## Code Map

- `docs/architecture/07-repo-and-workstreams.md` -- sections 1 (layout), 2 (CODEOWNERS), 6 (Compose profiles `platform`, `web`, `lab`, `mocks`), 7.7 row 0; follow them, change nothing there.
- `scripts/check-docs.mjs`, `scripts/verify-skills.mjs` -- existing; CI runs the verifier, nothing else touches them.
- `.gitattributes`, `.gitignore` -- LF rules and ignores already exist; reuse.
- `.githooks/commit-msg` -- existing backstop; unchanged.
- Nothing else exists: no `.github/`, `package.json`, `pyproject.toml`, `infra/`.

## Tasks & Acceptance

**Execution:**
- [ ] `.node-version`, `.python-version`, `package.json`, `pnpm-workspace.yaml`, `pyproject.toml` -- pin Node, Python and pnpm (`packageManager`); empty uv and pnpm workspaces; generate `pnpm-lock.yaml` and `uv.lock` -- one toolchain for all streams
- [ ] layout folders of architecture section 1 with `.gitkeep` -- every stream has its home
- [ ] `infra/compose/compose.yaml` -- Compose project `vulnmart` with the hardened `hello` service under profile `hello`; comments name the four stream profiles later stories fill
- [ ] `scripts/dev.mjs` -- commands `hello`, `up <profile...>`, `down`, `doctor`, `--help`
- [ ] `scripts/dev.test.mjs` -- node:test unit tests for argument parsing, error messages and the Docker-down path
- [ ] `.github/CODEOWNERS` -- every path in architecture section 2 with the real handles
- [ ] `.github/workflows/ci.yml` -- on pull requests and pushes to `main`: read-only token; verify skills, run script tests, frozen-lockfile installs, `docker compose config`, `dev.mjs hello`
- [ ] `README.md` -- add a short "Developer commands" section
- [ ] `docs/assets/l-01-repository-skeleton/` -- real `doctor` and `hello` output from Tanmay's PC (LB-2)
- [ ] Human step (Tanmay): Docker Desktop and WSL data on D:, memory cap in `%USERPROFILE%\.wslconfig`, Docker Desktop running

**Acceptance Criteria:**
- Given a fresh clone and Docker running, when `node scripts/dev.mjs hello` runs, then the I/O matrix "Hello works" row holds.
- Given Docker is stopped, when it runs, then the "Docker not running" row holds and no container remains.
- Given the hello container is running, when it is inspected, then it runs as non-root with a read-only root, no capabilities, no-new-privileges, a loopback-only port and no bind mounts.
- Given a pull request to `main`, when CI runs, then every job passes.
- Given the repository, when versions are searched, then every tool and action version is exact and `latest` appears nowhere.
- Given Tanmay's PC, when `node scripts/dev.mjs doctor` runs, then all checks PASS and the output is saved as evidence.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Pass 1 (thorough: blind-hunter BH, edge-case-hunter EH, verification-gap VG, intent-alignment IA).

| Finding | Verdict | Route | Evidence / action |
|---|---|---|---|
| BH1, EH14, IA: dev-log, changelog and traceability say Docker was down; evidence says it works | medium | patch | Real: docs written before Docker was repaired. Updated at close from the real evidence. |
| BH2: hello evidence has no real `docker ps` output | low | patch | Re-capture with an explicit "0 containers" line. |
| BH3, EH9, EH17, IA: doctor never compares tools with the pins | medium | patch | Real: Node 24.11.0 passes against pin 24.21.0, so Akshay on Node 22 would pass. Doctor compares Node major and pnpm exact version with the pins and FAILs on mismatch; test added. |
| BH4, EH2, EH18, IA: UTF-8 BOM in CHANGELOG.md, pyproject.toml, dev-log, evidence | medium | patch | Real, written by PowerShell. Already stripped; `.python-version` newline added. |
| BH4 extra: add `.editorconfig` | low | rejected | New file, out of scope; `.gitattributes` already pins LF. |
| BH5: `.gitignore` lacks node_modules, .venv, __pycache__ | false | rejected | `.gitignore` lines 10, 11 and 13 already hold them. |
| BH6, EH1, EH15, EH16: CODEOWNERS lists several patterns on one line (lines 96 and 97); comment says `*` needs all three | medium | patch | Real: GitHub reads the later patterns as owners. One pattern per line; comment fixed (any one listed owner satisfies). |
| BH6: root files and `/packages/` not covered | false | rejected | `*` covers every unlisted path. |
| BH7, EH13: CI jobs have no `timeout-minutes` and no concurrency group | medium | patch | Real: jobs skills, scripts, installs, compose have neither. |
| BH7: no Windows CI job | low | defer | Cost and Linux containers; revisit in L-12. |
| BH7: action SHA comments not verified | false | rejected | SHAs came from `git ls-remote` of those tags on build day. |
| BH7, VG3: hardening only checked by hand | medium | patch | Real: a unit test reads `compose.yaml` and asserts the hardening lines. |
| BH8, EH12: hello has no memory or pids limit | low | patch | Cheap; architecture runtime profile names limits. `mem_limit` and `pids_limit` added. |
| BH9: `rm -f vulnmart-hello` could remove a foreign container | false | rejected | The name is project-specific; stale removal is the plan's matrix row. |
| BH9: port-check race, `up` has no port check, `down` volume note, win32 shell branch and `main()` untested | low | rejected | Unlikely in daily use; each fix adds branches. |
| BH9: `calls.at(-2).includes('down')` is brittle | medium | patch | Joined with VG1: tests assert full argument strings. |
| BH10: LB-1, LB-2 not in initial.md | false | rejected | They are the epic's own requirement ids. |
| BH10: tracker state and commit field not updated | false | rejected | Done at close, after review and tests. |
| BH11: README troubleshooting and install notes | low | rejected | Out of scope for the skeleton. |
| BH12: pnpm supply-chain controls, `engines` field | medium | defer | A team decision, not a defect; recorded in deferred-work.md. |
| EH3: entry guard breaks with a link or drive-letter case | medium | patch | Plausible on Windows (`c:\` vs `C:\`) and exits 0 silently. Use `import.meta.main`. |
| EH4: `spawnSync` has no timeout | medium | patch | A hung Docker Desktop hung checks earlier on this PC. Add timeouts. |
| EH5: Ctrl-C during hello leaves a container | low | rejected | The next `hello` removes a stale container first (matrix row). |
| EH6, EH7, EH8: portFree error codes, 0.0.0.0 probe, response error event | low | rejected | Message stays roughly right or the socket timeout covers it; fixes add branches. |
| EH10: `config --services` may fail for an empty profile | false | rejected | Ran it: exit 0, empty output. |
| EH11: `down` exits 1 when Docker is stopped | low | rejected | Documented behaviour, same message as the other commands. |
| VG1: tests do not pin `--profile hello` | medium | patch | Real, confirmed in the test file. |
| VG2: no tests for `up`/`down` success and compose failure | medium | patch | Real. |
| VG: CODEOWNERS handles not verified to exist | low | rejected | Given by the developer on 2026-10-08. |
| IA: CI never run, macOS never run | maybe-false | defer | Needs a real pull request and Akshay's Mac; covered by the story's risk check. |
| IA, EH19: layout folders absent from the diff | false | rejected | 27 `.gitkeep` files exist; the review diff left them out. |
| IA: `image.png` untracked | low | rejected | The developer's screenshot, not part of this change. |

## Design Notes

Compose profiles: `dev.mjs up lab` runs `docker compose --profile lab up`; a profile with no services yet exits with a clear message instead of failing silently. Hello container: a small pinned `busybox` image serving one static page from a memory-backed `/tmp`.

## Verification

**Commands:**
- `node --test scripts/` -- expected: all tests pass
- `node scripts/dev.mjs doctor` -- expected: every check PASS, exit 0
- `node scripts/dev.mjs hello` -- expected: prints `hello`, exit 0, no container left (`docker ps -a` empty for the project)
- `pnpm install --frozen-lockfile` and `uv lock --check` -- expected: exit 0
- `docker compose -f infra/compose/compose.yaml config -q` -- expected: exit 0

**Manual checks (if no CLI):**
- Open the pull request on GitHub and confirm the CI run is green.
