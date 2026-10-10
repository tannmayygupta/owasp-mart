# Sprint 1 pull request checklist (Tanmay)

Created 2026-10-10. The pull request is raised by the developer from the personal GitHub account after all sprint 1 tasks are done (decision of 2026-10-10). Until then everything lives on `sprint-1-tanmay`.

## Before the pull request
- [ ] All tasks of sprint 1 (L-01 to L-08) are done and ticked in `docs/dev/dev1-tanmay.md`.
- [ ] Excel: Done = Yes for every finished task (by hand).
- [ ] `node scripts/verify-skills.mjs`, `pnpm run ci:linux` and `node scripts/dev.mjs harness` pass on the final tree.

## After the pull request is opened: record the first real CI result
These checks were never run on GitHub; their stories were marked done on 2026-10-10 with the CI result pending. Record the real result here and in each dev-log; a failure becomes a bug story.
- [ ] Job `scripts` (unit tests, stub tests, Python tests, `contracts:check`): story 1.4 (L-04), 1.9 (L-05), 1.10, 1.11.
- [ ] Job `e2e` (lab, orchestrator, events end-to-end): story 1.11.
- [ ] Job `compose` (harness): story 1.5 (L-06).
- [ ] Jobs `skills` and `installs`.
- [ ] mTLS tests on Linux (stories 1.10, 1.11): Linux proof already passed in Docker.

## Tell the team
- [ ] Akshay: message in `docs/dev/messages/2026-10-09-akshay-orchestrator-contract.md`; handoffs H-83 to H-94; IF-2 ready for P-04; RFC 9457 and signed CSRF decisions.
- [ ] Sahil: harness and stub for T-03 and T-04 (handoff H-92).