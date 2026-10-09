# Test Automation Summary: L-03 instance event contract (IF-4) and the fake ingest

Date: 2026-10-09 · Story: initiative-lab, epic-lab-baseline, entry 3 (L-03) · Framework: `node:test` (already used by the repository); the feature has no UI, so the tests drive a real HTTP server and the command line.

## Generated tests

### End-to-end tests (real server process, black box)
- [x] `scripts/e2e/events.e2e.test.mjs` (9 tests). Run with `node --test "scripts/e2e/events.e2e.test.mjs"`. The fake ingest runs as a separate process on a free port; requests are signed by an independent copy of the rule in `app-events.md` section 4 (the repository's signing helper is not used).
  - all 29 valid example types answer 202, an identical repeat answers 200, and 29 events are stored
  - the same `(instance_id, seq)` with a different body answers 409 and nothing new is stored
  - a bad signature and an unknown instance answer 401, and the answer never repeats the signature or names the unknown instance
  - a 20 KiB body answers 413 and the next request is answered normally
  - a flag-like string (`VM{`, `vm{`, `VM%7B`) in data answers 422 and is never echoed
  - an unknown type and an extra field answer 422 and name the path
  - GET answers 405, and a client that aborts in the middle of a body does not stop the server
  - the derived posted-body schema (Ajv) accepts every valid posted example and refuses source `sidecar` or a `seq`
  - `--write-posted` on a temporary copy leaves the committed posted schema unchanged

### Other tests of this story (written during implementation)
- [x] `scripts/validate-events.test.mjs` (42 unit tests), `scripts/e2e/contracts.e2e.test.mjs` (9 tests: fresh-checkout parity, both contract checks, broken-copy cases, the spawned server).

## Real results (Tanmay's PC, Node 24.11.0)
- New e2e file: 9 of 9 pass, stable over 5 runs. All unit tests: 82 of 82. Contract e2e: 9 of 9. Output in `docs/assets/l-03-instance-events/`.
- Sensitivity check: with a deliberately wrong signing key in a temporary copy of the new tests, 6 of 9 fail, so the tests depend on the real signing rule.

## Coverage
- Every answer code of the fake ingest (202, 200, 409, 401, 413, 422, 405) and all 29 event types are covered end to end. Not covered: the 503 store-full answer end to end (unit test only), macOS and Linux, the CI run, a real sidecar or shop (L-06 and Sahil's shop).

## Next steps
- Open the early pull request and confirm CI is green; add the e2e tests to CI with the L-07 contract job.
