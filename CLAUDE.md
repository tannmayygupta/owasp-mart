# VulnMart — rules for Claude Code (all developers)

VulnMart is a containerized, flag-based vulnerable web app for OWASP Top 10 training and automated pentest assessment. Three developers (Tanmay, Akshay, Sahil) build it with Claude Code.

## Read first
- `initial.md` is the **source of truth** (decisions D-01 to D-13, requirements, open questions). Read it before starting work.
- If a task conflicts with `initial.md`, or touches something marked OPEN, **stop and ask the developer**. Do not decide it yourself.

## Working rules
1. **Do not lock things directly.** Research first, then use industry-ready, proven solutions. Record a decision in `initial.md` (Section 15) only after the developer confirms it.
2. **Ask clarifying questions. Never assume.**
3. **Explain in plain language**, only what is necessary, concisely.

## Documentation rule (mandatory, for every task)
The documents are raw material for the final report. After finishing each task, **before committing**:

1. **Dev-log entry:** create `docs/dev-log/YYYY-MM-DD-<developer>-<task-slug>.md` from `docs/dev-log/_TEMPLATE.md`. Fill every section. Developer name: `git config user.name`.
2. **Decision record:** if the task made or changed a significant technical decision, add `docs/adr/NNNN-<title>.md` from `docs/adr/0000-template.md`, with the research sources.
3. **Changelog:** add a line under `[Unreleased]` in `CHANGELOG.md`.
4. **Traceability:** update the rows in `docs/traceability.md` for every requirement ID the task touches (F-numbers, challenge numbers, D-numbers).
5. **Evidence:** screenshots and outputs go in `docs/assets/<task-slug>/`.

Truthfulness rules:
- Record **real** test commands and **real** results. Never write that something passed unless it was run.
- Record problems met and how they were fixed, including dead ends.
- If you do not know a detail (why, who decided, a result), **ask the developer**. Do not invent it.
- Never write real flag values, secrets, keys, or personal data in docs. Describe where a flag lives, not what it is.

## Git
- The remote is `origin` on the personal GitHub account `tannmayygupta`, repo `owasp-mart` (private). Use **SSH only**, no HTTPS or tokens. On Tanmay's PC the SSH alias is `github-personal`; never use the work alias for this project.
- Push only when the developer asks. Never change the remote or force-push without asking.

## How the rule is enforced
- `.claude/settings.json` runs `scripts/check-docs.mjs` before any `git commit` Claude makes. It blocks the commit when code changed without a dev-log entry and a `CHANGELOG.md` update.
- Backstop for commits made outside Claude: run **once per clone** `git config core.hooksPath .githooks`.
- Non-functional commits (formatting, typos): add `[no-doc]` to the commit message. Features and fixes always need docs.
- Needs Node.js on the machine. The script fails open on unexpected errors, so it never traps a developer.

## Repo map
- `initial.md` — source of truth · `CLAUDE.md` — these rules
- `docs/dev-log/` — one file per task · `docs/adr/` — decision records · `docs/traceability.md` — requirement to code to test to result
- `docs/report/` — report notes (college template pending) · `CHANGELOG.md` — what changed
