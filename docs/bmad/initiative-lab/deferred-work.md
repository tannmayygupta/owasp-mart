- source_plan: `docs/bmad/initiative-lab/epic-lab-baseline/story-repository-skeleton-and-tooling-run-end-to-end-tracer-bullet-plan.md`
  summary: Add a Windows CI job for `dev.mjs` (the Windows shell branch has no test).
  evidence: BH7 of the L-01 review; revisit in L-12 (CI image builds).
- source_plan: `docs/bmad/initiative-lab/epic-lab-baseline/story-repository-skeleton-and-tooling-run-end-to-end-tracer-bullet-plan.md`
  summary: Decide supply-chain controls for pnpm (minimum release age, trust policy) and an `engines` field while the workspace is empty.
  evidence: BH12 of the L-01 review; a team decision, not a defect. Settle before the first dependency is added.
- source_plan: `docs/bmad/initiative-lab/epic-lab-baseline/story-repository-skeleton-and-tooling-run-end-to-end-tracer-bullet-plan.md`
  summary: Confirm CI green on a real pull request, and `node scripts/dev.mjs hello` on Akshay's Mac and Sahil's PC.
  evidence: IA of the L-01 review; unverified until the pull request exists and the story's risk check is run (would be medium).

## From the L-04 follow-up review (2026-10-09)
- FIXED in story 1.11: negative test for `scripts/check_orchestrator_contract.py` with `owner_hash` and `first_seq` in a GET answer schema (fails when the two names are removed from the checker).
- OPEN (Akshay, handoff H-59, not decided here): `first_seq` has no upper bound in the schema; the fake service accepts `1.0` while the Python host rejects it; a reset may use a lower `first_seq` than an earlier epoch (the platform alone prevents it). Decide the bound and the rule with Akshay and match both fakes.
- FIXED in story 1.11: `test_an_oversize_body_is_refused` retries only on `ConnectionResetError` and `BrokenPipeError`.
- FIXED in story 1.11: the GET leak test parses every answer and checks keys and values.
- OPEN: storing `owner_hash` as the label and passing `first_seq` to the sidecar is contract text only; verified in L-06 and L-13.
## From story 1.10 review (2026-10-09)
- FIXED in story 1.11: the Node end-to-end tests run in CI (job `e2e`: lab, orchestrator, events; the nested pytest is switched off there by `VULNMART_E2E_SKIP_NESTED_PYTEST=1`; `contracts.e2e` and `dev.e2e` stay out, covered by other jobs).
- DONE on a Linux container (not yet on GitHub): the mTLS tests pass on Linux in Docker (`pnpm run ci:linux`, evidence in `docs/assets/story-1-11-review-gaps/`). The first real pull request run is still to be recorded.
- FIXED in story 1.11: tests for a missing `openssl` (`CI` `true` or `1` fails; `false`, `0`, empty and unset skip; Python and Node, the real branch run), expired, not-yet-valid and wrong-usage certificates (client and server side) and a TLS 1.1 client.
- OPEN: share one certificate helper between the Python and Node tests (two languages; would need a new tool or a committed fixture, a team decision); look at the 38 s runtime of the mTLS tests (the certificates are made once per module already; the remaining time is process starts).
## From story 1.9 review (2026-10-09)
- FIXED in story 1.11: ADR 0019 now cites sources read in this session (RFC 9457, OpenAPI 3.1.0, OWASP CSRF cheat sheet, Prism). Decided by the developer 2026-10-09: M1 adopt RFC 9457, change PENDING in story 1.12 (IF-5 and IF-2 error bodies; handoff H-91); M2 signed, session-bound CSRF token plus `Sec-Fetch-Site`, text done, implementation Akshay P-05 (H-90). See the ADR.
- OPEN (OI-38, `lab-api.md` row 31): when one of several open held flags on a challenge is accepted, are `solved` and `held` both true? Proposal: accepting any flag credits and resolves the held state; rejecting keeps it held until none is open. The mock credits and keeps held meanwhile.
- DEFERRED (low, with reasons): the timeline is sorted by the `at` string while the cursor is an offset, and rows share timestamps (rows are appended in time order so paging is stable today; a sequence number would be the fix, when the real API exists); no examples yet for the new 422 unknown-query answer and the hint-order 409 (the placeholder codes may change with H-81 and story 1.12); the TLS 1.1 test cannot show whether the client or the server refused (the client is set to offer TLS 1.1; the server default minimum is 1.2); one certificate helper shared by Python and Node (see the story 1.10 item above).
- NOT IN CI, by design: `scripts/e2e/contracts.e2e.test.mjs` (fresh-checkout install parity; same commands run in the job `scripts`) and `scripts/e2e/dev.e2e.test.mjs` (needs the host Docker; the job `compose` covers `dev.mjs hello`).
- FIXED in story 1.11: the lab end-to-end test runs in CI (job `e2e`). OPEN: tie mock drift to `contracts:check` (the conformance test in `test_lab_contract.py` runs in the `scripts` job, so drift fails CI already; a separate drift check in `contracts:check` is not planned).
- FIXED in story 1.11 (each with a test that failed on the old mock): no duplicate timeline rows on repeated correct flags; deciding one held flag does not clear others; hint levels in order; strict cursor format; unknown or repeated query parameters on every GET (and 422 declared on every GET in the OpenAPI file); listen errors and port range (exit 2); exact example counts from the manifests; every declared response header asserted; the lab end-to-end tests are order independent with an exact answer count; the 413 test sees the 413 (and a huge body is proved separately, where the contract allows a dropped connection).
- NOT A DEFECT, test added as a guard: timeline pages were already stable when the list grows (rows are only appended); the new test passed on the old mock too.
## From story 1.5 (L-06 stub shop and lab harness, 2026-10-10)
- DEFERRED (low, with reasons): the test-only routes `/_stub/*` of the stub shop are reachable on the player port (the harness binds 127.0.0.1 only and the flag is a fresh fake one; block `/_stub/` at the stub gate later, when a harness user needs it).
- DEFERRED (L-12): the stub image build is not reproducible (npm resolves the transitive dependencies of Ajv at build time, no lockfile in the image build); pin them with the image build pipeline.
- DEFERRED (low): sidecar buffer-overflow statistics edge case (an overflow while an event is in flight can count a delivered event as dropped).
- DEFERRED (documented): the injector leaves partial files after exit 12 or 13; the volumes are discarded with the failed instance, so nothing reads them.
- DEFERRED: the healthchecks of sidecar, gate and edge are TCP only, and `depends_on` does not order them against each other (the harness waits for health itself); real health paths belong to L-13 and L-17.
- DEFERRED: CI runs the harness twice (job `compose`: `dev.mjs harness` and the harness end-to-end file) and without a Docker layer cache; cut one run or add caching if the job gets slow.
- DEFERRED: the conformance check does not compare the pins of the Dockerfile (Ajv versions) with `package.json`.
- DEFERRED (weak): the injector test asserts the order flags file before marker by file modification time only; the exit 13 marker-failure test proves the order directly.
- OPEN: the first CI run of job `compose` (harness on a Linux host) is still to be recorded; so far the harness has only run against the Docker Desktop Linux engine on Windows.
## From story 1.6 (L-07 contract checks live in CI, 2026-10-10)
- DEFERRED (L-09 or a CODEOWNERS and approvals check): the registry and `scripts/check-contract-rules.mjs` can switch off their own rules in the same pull request (edit the registry, the script, `ci.yml` or the pinned oasdiff list). Only a required reviewer on `contracts/registry.json`, `scripts/` and `.github/` (CODEOWNERS or the approvals check of L-09, EF-30) closes it.
- NOT SET UP: the job `contract-rules` runs on pull requests only. There is no run on push to `main` and no required status check; both need a decision (branch protection on a private personal repository is UNVERIFIED, architecture 07 section 2).
- DEFERRED: `oneOf` and `anyOf` branches of the JSON Schema diff are matched by deep equality (then by position); a branch that moved and changed is reported as removed or changed. Written in ADR 0012.
- DEFERRED: the oasdiff download has no cache and no mirror (a GitHub outage fails the job; 60 s limit and two retries only). Add `actions/cache` on `tools/.bin` or a mirror if it becomes a problem.
- DEFERRED (cost): `pnpm run ci:linux` copies `.git` into the container (about 4 MB today) so the contract rules can compare with `origin/main`; revisit if the repository grows. It stops early when `.git` is a file (a worktree) or `origin/main` is missing.
- BY DESIGN: examples and Markdown files of a contract are not compared for breaking changes (only the registered schema and OpenAPI files); a Markdown change needs a changelog entry but no mock change, and Markdown, test files and whitespace-only edits under a mock path do not count as a mock change.
- DEFERRED: a check that a migration touches only the tables of its own module, apply-from-empty migrations, and a consumer test against the mock (architecture 07 section 5) are not built.
## From story 2.1 (L-08 Oracle hosts) review (2026-10-10)
- OPEN (handoff H-103 to L-15 and L-29): the host firewall covers the INPUT chain only, so Docker-published container ports bypass it; containers can reach the VCN private range and the metadata address 169.254.169.254; no egress control on VM-I; one subnet for both VMs (NFR-ISO-06). Not implemented in L-08 by design.
- DEFERRED: iptables rule ordering (the allow rules go before the vendor REJECT) is tested only live, in `verify-hosts` (per-port `iptables -C`); reason: needs a real Oracle Ubuntu image.
- DEFERRED: fail2ban or similar for SSH; reason: SSH is key-only and limited by the network group to listed addresses, and a lockout tool adds risk for two hosts.
- DEFERRED: IPv6 rules; reason: the VCN has no IPv6, the validated inputs reject `::/0`, and the address redaction handles IPv6 text.
- DEFERRED: a static Terraform security scan (tfsec or checkov); reason: a new tool needs the team's agreement (CLAUDE.md), the native tests and the policy test cover the firewall rules.
- DEFERRED: generate the ports in the cloud-init template and the firewall script from `network-rules.json` (today a test ties the script's ports to the file); reason: more template code for two ports.
- DEFERRED: a remote Terraform backend with locking and state encryption; reason: one operator, local state with encrypted backup is written in the runbook.
- OPEN: all live results (account, apply, `verify-hosts`, `private-link-check`, alarm queries, capacity, latency, terms e-mail reply); the story stays open until they are recorded.
