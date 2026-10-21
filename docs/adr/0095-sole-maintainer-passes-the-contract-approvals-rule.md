# 0095. A sole maintainer passes the contract approvals rule

- **Status:** Accepted (the leader instructed it on 2026-10-21; Claude approved under D-104)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay), with Claude Code
- **Requirements:** ADR 0029 (approvals by CI and the tag), D-102, D-104, D-105

## Context
After the tag `contracts-v1.0.0` the CI rule `approvals` asks, for every pull request that changes a contract, for a review by a listed person who is not the author. The only listed people other than the leader are developers who left the project, so no contract change could be merged.

## Options considered
1. **A "Sole maintainer" line in the base COMPAT.md (chosen).** The author, when named there, passes the rule; the rule reads the line from the base copy, so a pull request cannot add itself. All machine checks (oasdiff breaking-change diff, schema and example validators, changelog and mock rules, registry) still run. This is how single-maintainer repositories work in practice: protection comes from automated checks, not from a second reviewer who does not exist.
2. Leave the tag out: every contract change stays advisory, which is what the audit criticised.
3. Remove the approvals rule: loses the record of who may approve if a second maintainer ever joins.

## Decision
Option 1. When a second maintainer joins, remove the line and the rule applies again.

## Consequences
- Contract changes can be merged on green CI; the first PR that adds the line is not itself covered (it changes no contract file).
- The control is CI; it must stay strict. Branch protection on `main` requires the five checks, up to date.