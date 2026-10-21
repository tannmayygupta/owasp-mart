# 0094. Claude approves under the leader's standing authority

- **Status:** Accepted (the leader instructed it on 2026-10-21)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay), with Claude Code
- **Requirements:** D-102, D-104; contract approvals (`contracts/COMPAT.md`, ADR 0029)

## Context
After D-102 the project has one senior developer. The contract process still waited for approvals from developers who are gone (three `pending` rows blocked the tag `contracts-v1.0.0`), and handoffs waited for answers nobody could give.

## Options considered
1. **Claude approves, on automated evidence (chosen).** In a one-maintainer repository the standard practice is that the maintainer's review is backed by machine checks: breaking-change detection on the OpenAPI files (oasdiff, already in CI as `contracts:rules`), the schema and example validators, and the consumers' own test suites. The approval records which checks were green.
2. Keep the leader as the approver: every sign-off waits for him; rejected, it is what stalled the tag.
3. Remove the approval rows: rejected, they are the record that a consumer was checked.

## Decision
Claude approves and records "approved by Claude under the leader's standing authority (D-104)" with the evidence, merges its pull requests when CI is green, tags contracts from `main`, and leaves nothing `pending`. Limits that remain are those of Claude's tools: credentials, and security settings of the cloud account or the repository, which the leader runs from a prepared command.

## Consequences
- Easier: the contract tag, handoffs and stories close without waiting.
- Harder: no second pair of eyes; CI, the contract rules and the audits are the control, so they must stay strict. The leader can overrule any approval by saying so.