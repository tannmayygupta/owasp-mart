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

## Development workflow: BMAD (D-29 to D-31)
- Work is done with the **BMAD skills installed in `.claude/skills/`** (record: `docs/bmad/INSTALL.md`). One developer, one tracker, **one story at a time**: create the story (`bmad-ticket`), implement it (`bmad-build`), review it (`bmad-code-review` or `bmad-review`), test it (`bmad-qa-generate-e2e-tests` and the story's tests), then close it and start the next.
- Trackers are files under `docs/bmad/` (one `initiative-<slug>` folder per developer). Set your own with `active_initiative` in `_bmad/custom/config.user.toml` (gitignored). Do not edit another developer's tracker folder.
- A story is not done until its tests ran and passed (real output recorded), the dev-log entry, changelog line and traceability rows exist (documentation rule above), and the tracker shows the new state.
- **Never update the skills automatically.** No `npx skills update`, no skill installs, no `bmad setup` that changes versions, without the team agreeing. After any `git pull` run `node scripts/verify-skills.mjs`; if it fails, stop and tell the developer.
- BMAD scripts need `uv` on the machine (see `docs/bmad/INSTALL.md`).
- **Task cycle (mandatory, one task at a time).** Each developer's task list is `docs/dev/dev<N>-<name>.md`; the guide is `docs/dev/START-HERE.md`. When a developer asks to work on a task:
  1. Work on one task only; do not start another until the current one is closed. Never code outside a BMAD story.
  2. Find or create its story with `bmad-ticket` (if the epic has no stories yet, incept the epic using that epic's tasks from the developer's task file as the breakdown, and show the result for approval). Never edit another developer's tracker folder.
  3. Build with `bmad-build` (full route), then review with `bmad-code-review`, then test (the story's tests and `bmad-qa-generate-e2e-tests` for visible or API behaviour). Record real commands and real output only.
  4. Close: apply the documentation rule, tick the task in the developer's task file, mark the story done with `bmad-ticket` only after the developer confirms, and remind them to set Done = Yes in their Excel sheet.
  5. Stop and ask the developer before the next task. If a requirement, decision or open question (OI-xx) is unclear, stop and ask; do not decide it.
- **Tracker automation (D-30).** Whoever finishes a story updates its state in the tracker in the same commit: the story's plan file under `docs/bmad/initiative-<slug>/` (via `bmad-ticket`), never another developer's folder. Initiatives: Akshay = `initiative-platform`, Tanmay = `initiative-lab`, Sahil = `initiative-target`. The commit gate blocks a code commit that has no tracker update once an initiative folder exists. Also tick the task in your `docs/dev/dev<N>-<name>.md` file. The Excel workbook `docs/bmad/VulnMart-Tracker.xlsx` is updated **by hand** (never regenerated over edits) and is not checked by the gate.

## Git
- The remote is `origin` on the personal GitHub account `tannmayygupta`, repo `owasp-mart` (private). Use **SSH only**, no HTTPS or tokens. On Tanmay's PC the SSH alias is `github-personal`; never use the work alias for this project.
- Push only when the developer asks. Never change the remote or force-push without asking.
- Branches: never commit to `main`. One branch per developer per sprint, `sprint-<n>-<name>` (for example `sprint-1-akshay`), one pull request per sprint of 8 tasks. A task marked EARLY PR in the task file goes on its own branch `shared-<task-id>` from fresh `main` with its own small pull request. Pull request review is optional during initial development (D-37, 2026-10-08): the author may merge once CI is green. When a contract or another stream's path changes, tell its owner in the team chat.
- Other developers use their own SSH key with `git@github.com:tannmayygupta/owasp-mart.git`; the alias `github-personal` is only for Tanmay's PC.

## How the rule is enforced
- `.claude/settings.json` runs `scripts/check-docs.mjs` before any `git commit` Claude makes, from either the Bash or the PowerShell tool. It blocks the commit when code changed without a dev-log entry and a `CHANGELOG.md` update.
- Backstop for commits made outside Claude: run **once per clone** `git config core.hooksPath .githooks`.
- Non-functional commits (formatting, typos): add `[no-doc]` to the commit message. Features and fixes always need docs.
- Needs Node.js on the machine. The script fails open on unexpected errors, so it never traps a developer.

## Repo map
- `initial.md` — source of truth · `CLAUDE.md` — these rules
- `docs/dev/` — each developer's task list by sprint (`dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`): tick a task when it is really done
- `docs/prd/` requirements · `docs/architecture/` design · `docs/design/` challenge specs · `docs/research/` research notes
- `docs/bmad/` — BMAD ticket trees per developer and the Excel tracker `VulnMart-Tracker.xlsx` (3 sheets, Done Yes/No, updated by hand)
- `docs/dev-log/` — one file per task · `docs/adr/` — decision records · `docs/traceability.md` — requirement to code to test to result
- `docs/report/` — report notes (college template pending) · `CHANGELOG.md` — what changed
