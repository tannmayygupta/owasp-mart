# Reply to the review of pull request 3 (ready to paste)

Thank you, this was a careful review. Everything below is fixed in the branch in one push, so a second round should not be needed. Where something is not proven yet, I say so. Test counts are from my own runs on the final tree.

**Must fix before merge**
1. **IF-7 registry and changelog.** IF-7 is now in `contracts/registry.json` (owner T, `contracts/catalog`, no longer reserved) and your IF-7 section is in `contracts/CHANGELOG.md`. `check-contract-rules` on the merged tree: 18 PASS, 0 FAIL.
2. **ADR numbers.** My two ADRs are now 0023 and 0024, with the references fixed (ADR index, ADR 0020, the IF-4 and IF-5 texts, handoffs, traceability, dev-logs, plans). Your 0017 and 0018 are untouched.
3. **Seven conflicts.** `origin/main` is merged into the branch; all seven files are unions (your rows, jobs and workspace entries are kept; `ci.yml` now has `apps` and `exploit-runner` next to my jobs; `package.json` has your `catalog:check`). Please look at the merge commit.
4. **IF-4 sign-off.** Marked STALE at the top of `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`, and handoff H-108 asks you to re-review IF-4 (and the hardened IF-6 schema).

**Dependent items**
5. **IF-4 sequence and epoch (ADR 0025, Proposed).** Every event now carries `epoch`; identity is `(instance_id, epoch, seq)`; the sequence restarts at 1 per epoch; `first_seq` is removed from IF-5 and the sidecar start input; seq lanes per source are enforced by the schema (an orchestrator event with seq 1 is rejected); the epoch is in the signature; the ingest answers 401 for a future epoch and stores older epochs under their own epoch. The sidecar saves its counter before each event (a real SIGKILL and restart test passes).
6. **Event key lifecycle.** The key is HKDF-SHA256 from a master with instance id and epoch in the context, so a reset gets a new key; there is a test vector and an independent HKDF in the e2e test. Request-signing keys (H-10) are proposed in ADR 0025 and handoffs H-105. The fake ingest derives keys per epoch.
7. **H-103 isolation.** Applied and verified live on 2026-10-11: two subnets, labs egress allowlist (443, DNS, NTP, 9444 to the platform host only), network ACL that denies the rest of the VPC, DOCKER-USER default-deny and a metadata block as host scripts, and a lint that forbids privileged and host-network lab containers (ADR 0027). I applied it and re-measured on the real hosts: `verify-hosts` RESULT PASS (107 checks, including the new probes: a bridge container and a non-root host-network container cannot reach the metadata service or `vm-p` on 443, and can still reach the ingest port) and `private-link-check` RESULT PASS (22 checks). I did not save the evidence files on that run and will add them. The first attempt failed on the labs host because it had been created stopped and its first boot was cut off; the rule and a follow-up are recorded (H-111). A root or privileged container can still bypass host filters; the VPC groups and the ACL are the real boundary.
8. **Checker graded by the PR itself.** The `contract-rules` job now checks out the base commit and runs the base checker, registry rules and oasdiff pins against the PR head (ADR 0026); changes to the registry, checker, pins or workflows fail unless the changelog has a `registry change:` line; CODEOWNERS covers those paths; the checks that need head code run in a separate job with `contents: read` and no secrets. **Not proven:** it has never run on GitHub. This pull request runs in bootstrap mode (the base has no trusted checker yet), so it is not protected itself; please review those paths by hand.
9. **Deleting a whole contract** is now breaking: it needs a raised version and a `BREAKING:` line (tests for delete, delete with bump, rename).

**Majors**
- **IF-6 template schema:** 40 new invalid examples, all rejected (network mode, image per role, component name, env values, shop health path, limits, injector ports and healthcheck, user and expiry, padded reason). Open item: the conformance check still cannot validate against the template schema (needs a compose-to-template mapper); recorded as H-110.
- **IF-5:** required `transition` on StateReport (duplicates and re-entrant transitions are now distinguishable), strict integers on the wire (`1.0`, `1e0`, booleans rejected), RFC 9457 problem details with an open schema, `ssl_context` must verify, 415 before 404 (ADR 0028).
- **IF-2:** stable `(epoch, seq)` cursor, `has_more` and `limit`, RFC 9457, flag answer only `correct` or `incorrect`, role table, 410 for withdrawn and cancelled reads. Open: evidence lists have no cursor yet (H-110).
- **IAM:** `ModifyInstanceAttribute` removed from the policy, plus an instance-type deny on RunInstances. The policy is pasted into the account and the apply worked without that action.
- **Terraform state:** an S3 backend example with native locking and a bootstrap script are ready; I have not migrated the state yet.
- **oasdiff and marker:** the pins were already checksummed (a test now checks every platform); the `BREAKING:` marker is one exact, case-sensitive line, so "no BREAKING changes" no longer matches; the tag baseline prints a NOTICE while no tag exists.
- **verify-hosts and private-link-check:** agreed, they prove connectivity from my address, not isolation. I will re-measure after applying and add the isolation probes (in `verify-hosts` now).

**Evidence (my runs)**
- `node --test "scripts/*.test.mjs"` and the stub-instance tests: 515 of 515.
- `pytest apps/api/tests`: 640 passed.
- `node --test "scripts/e2e/*.test.mjs"`: 71 of 72 on the first run; the only failure was a timeout in the fresh-checkout parity test, fixed; result of the rerun is in the dev-log.
- Terraform on a clean copy: aws 37 of 37, oci 10 of 10. `check-text-files` and `scan-secrets` pass.
- Not run: the workflow on GitHub, `ci:linux`. The S3 state move is prepared but not done.

Please re-review, especially the merge commit, the stale IF-4 sign-off (H-108) and the `ci.yml` union.