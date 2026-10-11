# Test Automation Summary: L-04 orchestrator contract (IF-5), fake orchestrator and `InstanceHost`

Date: 2026-10-09 · Story: initiative-lab, epic-lab-baseline, entry 4 (L-04) · Framework: `node:test` for the new end-to-end tests (already used by the repository), `pytest` for the Python suite written during implementation. The feature has no UI, so the tests drive a real HTTP service.

## Generated tests

### End-to-end tests (real service process, independent consumer)
- [x] `scripts/e2e/orchestrator.e2e.test.mjs` (11 tests). Run with `node --test "scripts/e2e/orchestrator.e2e.test.mjs"`. The fake orchestrator runs as a separate process on a free port; requests are signed by an own implementation of the rule in `orchestrator-api.md` section 4, checked first against `examples/signing-vector.json`. The Python client and the repository's signing code are not used; answers are checked by hand against the OpenAPI schemas.
  - the signing vector is reproduced
  - create answers 202, the instance reaches `ready`, a repeat is 200, another body with the same identity is 409
  - no GET answer (instance, list, host) holds a flag, decoy, digest, seed or event key
  - a body naming image, command, volumes, ports or env is refused with 422 `ORCH-FIELD-FORBIDDEN` and nothing is created; an unknown template is 422
  - a bad signature, a wrong key, a stale timestamp and a replayed nonce answer 401 and change nothing
  - access `open`, `frozen`, `closed` with a growing access epoch works; an older access epoch is 409
  - reset gives epoch + 1 and passes through `resetting` or `provisioning` back to `ready`; a wrong epoch is 409; the same reset again is 200
  - destroy answers 202 then 200, and a destroyed id cannot be created again (409)
  - list: label filters, cursor paging in id order, an unknown label and `limit=0` are 422; host answers capacity and usage
  - a host with little capacity answers 429 `ORCH-BUSY` with `Retry-After` and creates nothing
  - the Python suite (204 tests) still passes when run from the node test

### Other tests of this story (written during implementation)
- [x] `apps/api/tests/` (204 pytest tests: shared protocol suite on `FakeInstanceHost` and on `HttpInstanceHost` plus the fake service, HTTP service, contract), `scripts/e2e/contracts.e2e.test.mjs` (fresh-checkout parity including the Python tests).

## Real results (Tanmay's PC, Node 24.11.0, Python 3.14.8)
- New e2e file: 11 of 11 pass (53 s, almost all of it the Python suite); the 10 service tests are stable over 5 runs. Python: 204 of 204. Output in `docs/assets/l-04-orchestrator-api/`.
- Sensitivity check: with a deliberately wrong signing key in a temporary copy of the new tests, 10 of 10 service tests fail, so the tests depend on the real signing rule.

## Coverage
- All eight calls of the contract and the error codes `ORCH-BAD-SIGNATURE`, `ORCH-REQUEST-MISMATCH`, `ORCH-FIELD-FORBIDDEN`, `ORCH-TEMPLATE-UNKNOWN`, `ORCH-INSTANCE-NOT-FOUND`, `ORCH-INSTANCE-EXISTS`, `ORCH-STALE-EPOCH`, `ORCH-STALE-ACCESS-EPOCH`, `ORCH-LABEL-UNKNOWN`, `ORCH-VALIDATION`, `ORCH-BUSY` are covered end to end.
- Not covered end to end: signed state reports to a platform receiver (covered in the Python HTTP tests), `shop-fail-v0` failures, the 413 oversize body, mTLS, macOS and Linux, the CI run, a real orchestrator (L-13) and a real platform worker.

## Next steps
- Open the pull request or merge the sprint branch and confirm the CI `scripts` job, which now also runs the Python tests, is green.
- Add the new e2e file to CI with the L-07 contract job.
