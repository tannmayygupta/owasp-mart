# 0063. Sequenced learner runs with a countdown per challenge

- **Status:** Accepted (the developer answered the three questions below on 2026-10-20)
- **Date:** 2026-10-20
- **Deciders:** the developer (Tanmay), with Claude Code
- **Requirements:** C01 to C11, FR-SES-06 (one attempt per invite stays for companies), FR-DSH-01, FR-HNT-01; decisions D-80 (clock starts at ready), the one-attempt rule recorded on 2026-10-17 (`initial.md`, "One attempt per `(user_id, template_id)`")

## Context
A learner's lab was one attempt for all eleven challenges at once, with a 120-minute limit and one attempt per learner and template for ever. A learner whose attempt ended (time ran out) had no way to start again: the console hid the Start button and showed no challenges (found by the developer on the live lab). The developer asked for a sandbox feel: one challenge at a time, the others not visible, points on the account when a challenge is completed, and a countdown by difficulty (Easy 20, Medium 40, Hard 60 minutes).

## Options considered
1. **Per-challenge timer (chosen).** Each challenge has its own countdown, started when the learner begins it; it ends when captured or out of time; the next one appears. The run's overall limit is the sum of the times plus 30 minutes. Fits the sandbox idea; the shop still holds every weakness at once, so the lab, not the shop, decides what counts.
2. One timer for the whole run by the hardest tier (60 minutes): simple, but Easy challenges would get as much time as Hard ones.
3. The sum of all tiers as one timer (420 minutes): matches the workload but gives no pressure per challenge.
4. For ended runs: keep one attempt for ever (chosen against) versus allow a new run once the old one ended (chosen). The old rule made a finished learner a dead end.

## Decision
- **Sequence.** A practice run works through the challenges in catalogue order. Only the current challenge is listed; challenges ahead answer 404. The current challenge is `ready` until `beginChallenge` starts its countdown. Nothing counts for a challenge that is not active: not a flag, a hint, or a milestone event (the credit goes through `SequencedMilestones`). A challenge ends `solved` (a capture held for review counts) or `expired`; earned milestones stay.
- **No clock process.** The state of a challenge is worked out from the stored instant it was begun, the milestones and the clock. A restart loses nothing; there is no timer to miss.
- **Run limit.** A sequenced run lasts the sum of the challenge times plus 30 minutes (450 minutes for the eleven), and its instance may live as long as the run plus the margin; the idle stop still frees an abandoned instance after an hour.
- **New runs.** A finished learner run (submitted, reported, withdrawn, cancelled, deleted) no longer holds the learner's place for the template; the next start creates a new run and destroys what the old one still held. A company attempt in any state, and an unfinished practice run, still hold it (one attempt per invite). The database rule changes from a unique constraint to the partial unique index `uq_attempts_current` (migration 0017).
- **Account points.** The best result per challenge over all runs, shown out of 1000 on the same scale as one run's score (`getMyProgress`).
- **Scope.** Only learner practice runs are sequenced (`VULNMART_LAB_SEQUENCE=1` in the deployed compose file; off by default in code so the older tests and demos are unchanged). A company assessment is not.

## Consequences
- Easier: the learner sees one clear next step; a finished learner can play again; the platform can show account points.
- Harder: a run can hold an instance for up to 8 hours (the idle stop is the guard); capacity planning on vm-i should count this (OI-21).
- Contract: IF-2 1.3.0 (two operations, optional fields) and table owners 2.2.0 (one table). Consumers (Akshay's dashboards) are not forced to change: an old client sees the same fields plus optional ones, but a sequenced run lists fewer challenges.
- Watch: the console and the dashboards must show a learner with no running attempt a way to start a new run.

## Evidence
- Tests: `apps/api/tests/test_lab_sequence.py` (14), `test_lab_sequence_api.py` (8), the PG tests in `test_lab_pg.py`, `scripts/fake-lab.test.mjs` (see the dev-log of story 6 for the real results).
- No outside research was needed: the tiers and times are the developer's numbers; the run margin matches the candidate margin already in `runtime.py`.
