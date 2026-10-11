# Sprint 1 pull request checklist (Tanmay)

Created 2026-10-10. The pull request is raised by the developer from the personal GitHub account after all sprint 1 tasks are done (decision of 2026-10-10). Until then everything lives on `sprint-1-tanmay`.

## Before the pull request
- [ ] All tasks of sprint 1 (L-01 to L-08) are done and ticked in `docs/dev/dev1-tanmay.md`.
- [ ] Excel: Done = Yes for every finished task (by hand).
- [x] `node scripts/verify-skills.mjs` and `node scripts/dev.mjs harness` pass on the final tree (2026-10-11, real runs). `pnpm run ci:linux` was not run again (it was killed twice for low memory); the same commands were run one by one instead (see the story 1.15 dev-log).

## After the pull request is opened: record the first real CI result
These checks were never run on GitHub; their stories were marked done on 2026-10-10 with the CI result pending. Record the real result here and in each dev-log; a failure becomes a bug story.
- [ ] Job `scripts` (unit tests, stub tests, Python tests, `contracts:check`): story 1.4 (L-04), 1.9 (L-05), 1.10, 1.11.
- [ ] Job `e2e` (lab, orchestrator, events end-to-end): story 1.11.
- [ ] Job `compose` (harness): story 1.5 (L-06).
- [ ] Jobs `skills` and `installs`.
- [ ] mTLS tests on Linux (stories 1.10, 1.11): Linux proof already passed in Docker.

## Review round of pull request 3 (story 1.15, 2026-10-11)
- [x] Reviewer points fixed and pushed; reply comment ready in `docs/dev/messages/2026-10-11-pr3-review-reply.md`.
- [ ] Developer: read the real GitHub CI result of pull request 3, job by job, and merge when it is green (D-37); send the result to Claude if any job is red.
- [ ] Developer: paste `docs/dev/messages/2026-10-11-sahil-pr3-and-t04.md` to Sahil (T-04, T-09, T-10 unblock; he can start from `origin/sprint-1-tanmay`) and its last paragraph to Akshay (P-04 needs L-05).
- [ ] Excel: Done = Yes for L-01 to L-08, by hand.

## Tell the team
- [ ] Akshay: message in `docs/dev/messages/2026-10-09-akshay-orchestrator-contract.md`; handoffs H-83 to H-94; IF-2 ready for P-04; RFC 9457 and signed CSRF decisions.
- [ ] Sahil: harness and stub for T-03 and T-04 (handoff H-92).

## L-08 follow-ups (L-08 was marked done on 2026-10-11 by the developer; these stay open)
- [ ] Budget alert: confirm the AWS subscription e-mail in the inbox and check that the alert arrives.
- [ ] Akshay's and Sahil's public SSH keys added to both hosts (runbook Part G, push over SSH).
- [ ] Start rehearsal of a fully booted, stopped labs host: set `vm_i_running = true`, apply, run `verify-hosts` and `private-link-check` with `--evidence docs/assets/l-08-aws-hosts/...` (the host was stopped again on 2026-10-11 after a clean first boot; the evidence files were not saved on the 2026-10-11 run: `verify-hosts` 107 and `private-link-check` 22 PASS are from the terminal). Rule: never create or replace a host while it is switched off.
- [ ] After one week: record whether AWS reclaimed an idle instance (keep-alive is off); weekly credit check (balance USD 120 on 2026-10-11, plan end April 2027).
- [ ] Root MFA (skipped by choice, recorded risk).
- [ ] Optional: move the Terraform state to S3 (runbook "Move the state to S3"); until then keep dated copies of `terraform.tfstate` and `terraform.tfvars`.
- [ ] Optional: remove the unused `BootstrapStateBucketOnceRemoveAfterwards` statement from the IAM policy if the S3 move is not planned.