# Test Automation Summary: L-02 instance contract and `validate-contracts`

Date: 2026-10-08 · Story: initiative-lab, epic-lab-baseline, entry 2 (L-02) · Framework: `node:test` (already used by the repository); the feature has no UI or HTTP API, so the tests drive the command line.

## Generated tests

### End-to-end tests (real command line, clean copies)
- [x] `scripts/e2e/contracts.e2e.test.mjs` (7 tests). Run with `node --test "scripts/e2e/contracts.e2e.test.mjs"`.
  - fresh-checkout parity: copy the repository without `node_modules`, `pnpm install --frozen-lockfile`, then the CI `scripts` job command; asserts the unit tests really ran (at least 30)
  - `pnpm run contracts:check` passes and prints the counts
  - three broken-rule cases exit 1: no `epoch` in the injection schema, injector and shop on different `/run/vm` volumes, a real-looking flag in an example
  - usage: `--help` exits 0, an unknown argument exits 2, a missing folder exits 1
  - the contract text has sections 1 to 11 in order and at least 20 open-point rows, no byte-order mark

### Unit tests (existing, written during implementation)
- [x] `scripts/validate-contracts.test.mjs` (21 tests) and the existing `scripts/dev.test.mjs` (19 tests): 40 of 40 pass.

## Real results (Tanmay's PC, Node 24.11.0, pnpm 12.10.1)
- e2e: 7 of 7 pass in about 11 s (the fresh-checkout test about 7 s). Unit: 40 of 40 pass. Output in `docs/assets/l-02-instance-contract/`.

## What the tests found
- The first version of the fresh-checkout test passed without running any unit test, because a `node --test` started inside a test run inherits `NODE_TEST_CONTEXT` and prints no summary. A count check caught it and the test now clears the variable.

## Coverage
- Validator exit codes 0, 1 and 2 are all covered end to end. Contract sections 1 to 11 and the open-points table are covered.
- Not covered: macOS and Linux, the CI run on a real pull request, Sahil's consumer review, conformance of a real stub shop (L-06), the CI contract check (L-07).

## Next steps
- Open the pull request, get Sahil's approval, and confirm all CI jobs are green.
- Align the `INST-*` placeholder codes and catalogue field names after P-02 and T-02 merge.
