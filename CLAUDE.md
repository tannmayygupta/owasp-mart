# VulnMart — rules for Claude Code (the leader and Claude)

VulnMart is a containerized, flag-based vulnerable web app for OWASP Top 10 training and automated pentest assessment.

## Who builds this (decision D-102, 2026-10-21)
**Two parties only: the leader (Tanmay, git user `tannmayygupta`) and Claude Code.** There is no other developer. Akshay and Sahil are no longer on the project, and nobody else will review, sign off, merge or "own a stream". Everything is implemented end to end by the leader and Claude together:
- **The leader decides.** An instruction from the leader is the decision and the confirmation. Claude does what the leader instructs, completely and end to end, without waiting for anyone else.
- **Claude implements.** All streams belong to this pair: platform and dashboards (old stream P), lab, orchestrator and edge (old stream L), shop and challenges (old stream T), contracts, infrastructure, tests, documentation. Old ownership lines in `docs/`, task files, handoffs, `contracts/COMPAT.md` and `contracts/db/table-owners.yaml` are history. They do not stop Claude from changing any file.
- Old documents keep the names of the former developers as a record of who did what. Do not rewrite history. Do not wait for, ask, or write handoffs to people who are not here.

## Standing authority of Claude (decision D-104, 2026-10-21)
The leader is the only senior developer and has given Claude **every approval and every access Claude is able to use**. From now on:
- **Claude approves.** Contract sign-offs (`contracts/COMPAT.md`), decision records and `initial.md` decisions, handoff answers, story closing and pull-request merging: Claude researches the question, picks the **industry-standard solution**, approves it itself, and records the approval as "approved by Claude under the leader's standing authority (D-104) on <date>" together with the evidence (tests, checks, sources). **Do not leave a row `pending` or an item `open` waiting for the leader.** If the leader later disagrees, he says so and Claude changes it.
- **Research first.** For every decision use proven standards (OWASP ASVS and Top 10, NIST, RFCs, vendor documentation, the contract-testing practice of OpenAPI diffing and consumer-driven checks) and write the sources in the ADR. Automated evidence (CI, contract rules, oasdiff, test suites) is what an approval rests on.
- **Merge.** Claude merges its own pull request into `main` when the CI checks are green and the branch is mergeable. Never bypass a failing check, never fabricate a result.
- **Implement end to end.** No task is closed with a placeholder, a mock standing in for real behaviour, or a "needs the leader" note when Claude can do it. A real external blocker (a secret only the leader holds, a legal decision, an action the tools cannot perform) is written down with the exact reason and the exact next command, and everything around it is finished.
## Read first
- `initial.md` is the **source of truth** (decisions, requirements, open questions). Read it before starting work.
- If a task conflicts with `initial.md`, or touches something marked OPEN, research it, decide it under the standing authority and record the decision in the same task (Working rules 1). Ask the leader only when the answer depends on something only he knows (a secret, a legal choice, his intent).

## Working rules
1. **Do not lock things on your own.** Research first, then use industry-ready, proven solutions. Record a decision in `initial.md` (Section 15) and, when significant, an ADR, Claude confirms it under the standing authority above (or the leader's instruction in the conversation, written as "confirmed by the leader on <date>").
2. **Ask clarifying questions when the answer changes what you build. Never assume facts you can check in the code.** Do not ask for permission to do what the leader already told you to do.
3. **Explain in plain language**, only what is necessary, concisely. Be critical and honest: say what is broken, not only what works.
4. **Do the whole job.** A task is not finished at "the code compiles": it is finished when it works end to end for the roles it touches (learner, candidate, recruiter, admin), is tested for real, and is deployed when the leader asked for it live.

## Documentation rule (mandatory, for every task)
The documents are raw material for the final report. After finishing each task, **before committing**:

1. **Dev-log entry:** create `docs/dev-log/YYYY-MM-DD-<author>-<task-slug>.md` from `docs/dev-log/_TEMPLATE.md`. Fill every section. Author name: `git config user.name`.
2. **Decision record:** if the task made or changed a significant technical decision, add `docs/adr/NNNN-<title>.md` from `docs/adr/0000-template.md`, with the research sources, and a row in `docs/adr/README.md`.
3. **Changelog:** add a line under `[Unreleased]` in `CHANGELOG.md`.
4. **Traceability:** update the rows in `docs/traceability.md` for every requirement ID the task touches (F-numbers, challenge numbers, D-numbers).
5. **Evidence:** screenshots and outputs go in `docs/assets/<task-slug>/`.

Truthfulness rules:
- Record **real** test commands and **real** results. Never write that something passed unless it was run.
- Record problems met and how they were fixed, including dead ends.
- If you do not know a detail (why, a result), **ask the leader**. Do not invent it.
- Never write real flag values, secrets, keys, or personal data in docs. Describe where a flag lives, not what it is.

## Development workflow: BMAD (D-29 to D-31, simplified by D-102)
- Work is done with the **BMAD skills installed in `.claude/skills/`** (record: `docs/bmad/INSTALL.md`). **One story at a time**: create the story (`bmad-ticket`), implement it (`bmad-build`), review it (`bmad-code-review` or `bmad-review`), test it (`bmad-qa-generate-e2e-tests` and the story's tests), then close it and start the next. Never code outside a story.
- **One tracker.** All new stories go in `docs/bmad/initiative-lab/` (set `active_initiative` in `_bmad/custom/config.user.toml`, gitignored, if needed). The folders `initiative-platform` and `initiative-target` are the record of the former developers; their unfinished tasks are now backlog of this pair, and Claude may update a story there when the work belongs to it. The "never edit another developer's tracker" rule is withdrawn.
- A story is not done until its tests ran and passed (real output recorded), the dev-log entry, changelog line and traceability rows exist (documentation rule above), and the tracker shows the new state.
- **Never update the skills automatically.** No `npx skills update`, no skill installs, no `bmad setup` that changes versions, without the leader's say-so. After any `git pull` run `node scripts/verify-skills.mjs`; if it fails, stop and tell the leader.
- BMAD scripts need `uv` on the machine (see `docs/bmad/INSTALL.md`).
- **Task cycle (one task at a time).** The backlog is `docs/dev/dev1-tanmay.md`, the unfinished tasks of `dev2-akshay.md` and `dev3-sahil.md`, the open rows of `docs/dev/HANDOFFS.md`, and the audits in `docs/audit/`. When the leader gives a task:
  1. Work on one task only; do not start another until the current one is closed (unless the leader tells you to run several).
  2. Find or create its story with `bmad-ticket`.
  2b. **Handoffs.** Rows of `docs/dev/HANDOFFS.md` addressed to a task are inputs: read them, decide with the leader when it is unclear, record the answer in the row. Do not create new handoff rows for people who are gone; write the open point in the story or the ADR instead.
  3. Build with `bmad-build`, review with `bmad-code-review`, then test (the story's tests and `bmad-qa-generate-e2e-tests` for visible or API behaviour). Record real commands and real output only.
  4. Close: apply the documentation rule, tick the task in its task file, and mark the story done with `bmad-ticket` after the leader confirms (or when the leader told you to carry on without asking). The Excel workbook `docs/bmad/VulnMart-Tracker.xlsx` is no longer maintained by hand; do not block on it.
  5. If a requirement, decision or open question (OI-xx) is unclear, stop and ask the leader; do not decide it.
- **Contracts.** The versioning rules of `contracts/` stay (version bump, changelog entry, BREAKING line, `pnpm run contracts:rules` and `api:check`). There is no second party to sign off: a `pending` COMPAT row of a former developer is closed by the leader's decision, which Claude records as "approved by the leader on <date>" only when the leader says so.

## Git
- The remote is `origin` on the personal GitHub account `tannmayygupta`, repo `owasp-mart` (private). Use **SSH only**, no HTTPS or tokens. On the leader's PC the SSH alias is `github-personal`; never use the work alias for this project.
- Push branches and open pull requests as part of any task. Never change the remote or force-push.
- Branches: never commit to `main`. One branch per piece of work, named `<area>-<slug>` (for example `lab-invite-lifecycle`), one pull request per branch. The old sprint names (`sprint-<n>-<name>`, `shared-<task-id>`, EARLY PR) are retired: nobody is waiting on another branch. Review by another person is not required; Claude merges once CI is green (standing authority, D-104). Tags (`contracts-vX.Y.Z`) are created from `main` by `scripts/tag-contracts.mjs` after its checks pass.

## Limits that remain (what Claude's own tools forbid, not a lack of trust)
- Claude does not type a password or credential into a login form, and never prints or stores secrets in documents. A provider key (for example the mail API key) is placed by the leader into the secrets folder; Claude does everything around it (code, compose, checks, the exact command).
- Changes to security settings of the cloud account or of the repository (firewall and security-group rules, for example `scripts/allow-my-ip.mjs` which runs `terraform apply`; GitHub branch protection) are blocked for Claude by its tool permissions. Claude prepares the exact command and runs everything before and after it; the leader types it with the `!` prefix in the session. Always set `$env:AWS_PROFILE="vulnmart"` first. Do not print IP addresses or secrets in documents.
- Deployments use `node scripts/live-deploy.mjs` (`docs/runbooks/live-deploy.md`). Claude may deploy, enable the retention scheduler and configure real email in the compose files, and cancel live attempts in bulk when the task calls for it; each such step goes in the dev-log with its reason and real output.
## How the rule is enforced
- `.claude/settings.json` runs `scripts/check-docs.mjs` before any `git commit` Claude makes, from either the Bash or the PowerShell tool. It blocks the commit when code changed without a dev-log entry and a `CHANGELOG.md` update, and without a tracker update under `docs/bmad/initiative-<slug>/`.
- Backstop for commits made outside Claude: run **once per clone** `git config core.hooksPath .githooks`.
- Non-functional commits (formatting, typos): add `[no-doc]` to the commit message. Features and fixes always need docs.
- Needs Node.js on the machine. The script fails open on unexpected errors, so it never traps anyone.

## Repo map
- `initial.md` — source of truth · `CLAUDE.md` — these rules
- `docs/dev/` — the task lists and `HANDOFFS.md`, now the backlog of the leader and Claude
- `docs/audit/` — audits (the 2026-10-21 tracker, wiring and role-scenario audits are the current to-do list)
- `docs/prd/` requirements · `docs/architecture/` design · `docs/design/` challenge specs · `docs/research/` research notes
- `docs/bmad/` — BMAD ticket trees (`initiative-lab` is the tracker in use)
- `docs/dev-log/` — one file per task · `docs/adr/` — decision records · `docs/traceability.md` — requirement to code to test to result
- `docs/report/` — report notes (college template pending) · `CHANGELOG.md` — what changed
