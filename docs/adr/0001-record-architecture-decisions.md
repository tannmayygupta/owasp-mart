# 0001. Record technical decisions as ADRs in the repo

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** Tanmay Gupta (with Claude Code)
- **Requirements:** documentation rule in `CLAUDE.md`

## Context
The final report needs the "why" behind technical choices, and three developers work in parallel. Product decisions already live in `initial.md` Section 15 (D-numbers). Technical and implementation decisions need their own place.

## Options considered
1. Decisions only in chat or commit messages — easily lost.
2. A wiki outside the repo — drifts from the code.
3. Short decision records (ADRs) in `docs/adr/`, versioned with the code — the common industry practice.

## Decision
Use option 3. One short file per significant decision, using `0000-template.md`. A changed decision gets a new ADR and the old one is marked "Superseded by NNNN". Product-level decisions stay in `initial.md` (D-numbers); ADRs must not contradict them.

## Consequences
A little writing per decision, in exchange for a searchable record that feeds the report's design chapter.

## Evidence
Research on ADR practice (2026-10-08): [AdAction ADR 0001](https://eng.adaction.com/architecture-decision-records/shared/0001-record-architecture-decisions/), [Shopware ADRs](https://developer.shopware.com/docs/v6.5/resources/references/adr/2020-06-25-implement-architecture-decision-records.html), [adr.github.io](https://docsearch.algolia.com/mcp/docs/repo/adr/adr.github.io).
