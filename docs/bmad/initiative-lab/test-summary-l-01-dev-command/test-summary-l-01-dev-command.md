# Test Automation Summary: L-01 `scripts/dev.mjs` and the hello container

Date: 2026-10-08 · Story: initiative-lab, epic-lab-baseline, entry 1 (L-01) · Framework: `node:test` (already used by the unit tests; the feature is a command-line tool, so there is no UI or HTTP API to test beyond the hello container).

## Generated tests

### End-to-end tests against the real Docker engine
- [x] `scripts/e2e/dev.e2e.test.mjs` (10 tests). Run with `node --test "scripts/e2e/*.test.mjs"`.
  - help and an unknown command (exit codes, messages)
  - `doctor` passes every check on this PC
  - `hello`: starts a real container, prints `hello`, exits 0, leaves no container, frees port 18080
  - `hello` with a stale container from an earlier run
  - `hello` with the port busy: exit 1, names the port, starts nothing
  - `up lab` (profile with no services): exit 1, nothing started; `up bogus`: refused
  - `down`: removes a running hello container
  - hardening read from `docker inspect`: user 65532, read-only root, all capabilities dropped, no-new-privileges, not privileged, no bind mounts, loopback-only port, 64 MB memory, 64 processes, healthy

### Unit tests (already existed, written during implementation)
- [x] `scripts/dev.test.mjs` (19 tests, mocked runner). Run with `node --test "scripts/*.test.mjs"`.

## Real results (2026-10-08, Tanmay's PC, Docker 29.6.2)
- e2e: 10 of 10 pass, 56 s. unit: 19 of 19 pass.

## Coverage
- Commands of `dev.mjs`: 5 of 5 (`hello`, `up`, `down`, `doctor`, `--help`) are covered by e2e; every row of the plan's I/O matrix is covered by e2e and unit tests.
- Not covered: macOS, Linux and the Windows `shell` branch on other machines, CI on a real pull request, Ctrl-C during `hello`.

## Next steps
- Run the e2e tests on Akshay's Mac and Sahil's PC (the story's risk check).
- Consider running `scripts/e2e` in the CI `compose` job once CI is seen green (deferred).
