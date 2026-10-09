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
- Add a negative test for `scripts/check_orchestrator_contract.py` that puts `owner_hash` or `first_seq` into a GET answer schema and expects a failure (Verification Gap).
- `first_seq`: no upper bound in the schema; the fake service accepts `1.0` while the Python host rejects it; a reset may use a lower `first_seq` than an earlier epoch (the platform alone prevents it). Decide the bound and the rule with Akshay (handoff H-59) and match both fakes.
- `test_an_oversize_body_is_refused` retries on any `OSError`; narrow to reset and broken-pipe errors.
- The GET leak test uses substring checks; parse the JSON keys and values instead.
- Storing `owner_hash` as the label and passing `first_seq` to the sidecar is contract text only; verified in L-06 and L-13.
## From story 1.10 review (2026-10-09)
- Run the Node end-to-end tests in CI (they are not part of any CI job); plan with the contract CI story (1.6).
- Check the Linux CI result of the mTLS tests (TLS 1.3 refusal mapping, host name check); settled by the first pull request run.
- Add tests: missing `openssl` on CI really fails, `CI=false` handling, expired and wrong-usage certificates, TLS 1.1 refused; share the certificate helper between the Python and Node tests; look at the 38 s runtime.
## From story 1.9 review (2026-10-09)
- Read the external sources of ADR 0019 (OpenAPI 3.1, RFC 9457, OWASP CSRF, Prism docs) before the ADR is accepted.
- Run `scripts/e2e/lab.e2e.test.mjs` in CI and tie mock drift to `contracts:check` (story 1.6).
- Mock hardening (low): no duplicate timeline rows on repeated correct flags; deciding one held flag must not clear others; hint levels in order; strict cursor format; reject unknown query parameters on every GET; handle listen errors; pin exact example counts in tests; assert every declared response header; make e2e tests order independent; the 413 test must not accept a reset.