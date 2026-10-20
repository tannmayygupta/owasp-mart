# 0064. The team is the leader and Claude only

- **Status:** Accepted (the leader instructed it on 2026-10-21)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay), with Claude Code
- **Requirements:** D-29 to D-31 (BMAD workflow), D-37 (review optional), D-102

## Context
CLAUDE.md was written for three developers, each with a stream, a tracker, a task file, handoffs and sign-offs. Two of them are no longer on the project. The rules still told Claude to stop at another developer's files, to hand work to them and to wait for their sign-off. Audits of 2026-10-21 (`docs/audit/`) show the cost: handoffs nobody can answer (88 open rows), COMPAT sign-offs that stay `pending`, and a product that was split along ownership lines instead of user flows.

## Options considered
1. **Leader and Claude own everything (chosen).** One backlog, one tracker, no waiting for people who are gone.
2. Keep the stream rules and treat the missing developers as "unavailable": every cross-stream change would stay blocked or need a workaround.
3. Delete the old documents: rejected, they are the record needed for the final report.

## Decision
- The leader decides and confirms by instruction; Claude implements end to end and records the decision.
- Ownership lines, handoff rows to other people, per-developer trackers, sprint branch names, EARLY PR rules and the hand-kept Excel tracker are retired. Old files stay as history.
- Kept: `initial.md` as the source of truth, the documentation rule and truthfulness rules, BMAD one story at a time, the contract versioning rules, the commit gate, and a safety floor (no credentials typed for the leader, infrastructure and firewall changes run by the leader, the scheduler, real email and bulk cancellations only on his explicit go).

## Consequences
- Easier: Claude can fix a flow across platform, lab and shop in one change; no waiting.
- Harder: nobody else reviews; the leader's review and the real tests are the only checks. Code review by the agents (`bmad-code-review`) and the audits become more important, not less.
- Open: the `pending` COMPAT rows of former developers (IF-2 2.0.0, 2.1.0, database 2.2.0) stay as they are until the leader says to close them.