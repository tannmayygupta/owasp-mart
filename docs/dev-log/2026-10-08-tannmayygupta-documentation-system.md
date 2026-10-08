# Documentation system and commit gate

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, not committed yet |
| Status | Done, one check still pending (see Limitations) |
| Report tag | Process / documentation (college report template pending) |

## Requirements covered
Process requirement from the user (2026-10-08): every task Claude Code finishes must be documented so the docs feed the final report. Decision D-14 in `initial.md`. Not tied to an F-number.

## Summary
Created a dedicated git repo for VulnMart and a documentation system every developer's Claude Code follows: a rule file, templates, a decision-record folder, a changelog, a traceability table, and a gate that stops code commits that have no documentation.

## Why
The report needs real, detailed material about what was built, why, and how it was tested. Writing it all at the end loses detail. Three developers work in parallel, so the rule has to be shared through the repo and enforced, because the Claude Code docs say CLAUDE.md is advice, not enforcement.

## What was built
- `CLAUDE.md`: the rule (what to document after each task, truthfulness rules, how it is enforced).
- `docs/dev-log/` (template + this entry), `docs/adr/` (template + ADR 0001), `CHANGELOG.md`, `docs/traceability.md` (F1-F11 and C01-C11 rows), `docs/report/README.md`, `docs/assets/`.
- `scripts/check-docs.mjs`: blocks a commit when non-documentation files changed without a dev-log entry and a `CHANGELOG.md` update. `[no-doc]` in the commit message skips it for non-functional commits.
- `.claude/settings.json`: runs the script as a Claude Code PreToolUse hook on Bash commands.
- `.githooks/commit-msg`: the same check as a git hook, for commits made outside Claude Code.
- `.gitignore`: secrets, dependencies, build output, crash dumps.
- `.gitattributes`: keeps LF line endings for hooks and scripts on every machine.
- Remote: `origin` = `git@github-personal:tannmayygupta/owasp-mart.git` (SSH alias for the personal key, verified as `tannmayygupta`). Repo was created empty by the user.

## How it works
Claude Code calls the script before every Bash command. The script only acts when the command is a `git commit`. It lists the files that commit would include (staged files, files added by a chained `git add`, and tracked changes if `-a` is used). If any are code and the dev-log or changelog is missing, it returns a deny decision with a message telling Claude what to write. Any internal error lets the commit through, so it cannot trap a developer.

## Files changed
All files above are new. `initial.md` was updated (D-14, open questions).

## Decisions made
User chose, from researched options: new private repo; rule plus hook enforcement; full documentation set. Format choices follow ADR and Keep a Changelog practice. See `docs/adr/0001-record-architecture-decisions.md` and D-14 in `initial.md`.

## Tests
Run in throwaway git repos outside the project, with simulated Claude Code hook input and real git commands:
- First run: git commit-msg mode passed (3 of 3: complete commit allowed, code-only blocked, `[no-doc]` allowed). Hook mode **failed**: 3 commits that should be blocked were allowed.
- Second run: 8 passed, 2 failed. One failure was a mistake in the test (nothing was staged, so allowing was correct). The other was a real gap (see below).
- Final run: **13 of 13 scenarios passed**, including chained `git add -A && git commit`, `git add .`, `git add <paths>`, `git -C <path> commit`, `[no-doc]`, docs-only changes and non-commit commands. Earlier-run scenarios for `git commit -a` and `-am`, a dev-log without a changelog, and the commit-msg backstop also passed on the previous build.

## Evidence
Test output was shown in the Claude Code session on 2026-10-08. No screenshots saved.

## Problems met and how they were fixed
1. **Silent failure in hook mode.** PowerShell adds a byte-order mark when piping text, and `JSON.parse` rejected it, so the script failed open and allowed everything. Fixed by stripping the BOM and logging the swallowed error to stderr.
2. **Chained commands.** `git add -A && git commit` was allowed because the hook runs before the whole command, when nothing is staged yet. Fixed by reading the `git add` part of the command and including those files.
3. `major-project` was inside the home-folder git repo, whose remote is an unrelated project. Fixed with a dedicated `git init` here.
4. A stray `bash.exe.stackdump` (Git Bash crash dump) appeared in the folder. Not deleted; ignored through `.gitignore`.
5. **Line endings on other machines.** Git warned it would convert files to Windows line endings. The repo itself stores LF (`git ls-files --eol` shows `i/lf`), but a Windows clone with `core.autocrlf=true` would turn `.githooks/commit-msg` into CRLF and the backstop would silently stop working. Fixed with a `.gitattributes` that pins LF for hooks and scripts. Not yet tested on a fresh Windows clone.

## Security notes
No vulnerable code yet. The hook script runs with the developer's credentials, so every developer should read `scripts/check-docs.mjs` and `.claude/settings.json` once. The gate checks that docs exist, not that they are good.

## Limitations and follow-ups
- **Not yet seen running inside a live Claude Code session.** The script was tested with simulated input. First live check: restart Claude Code in this folder, accept the trust prompt if shown, confirm the hook with `/hooks`, and try a code commit without docs.
- `git commit-tree` could be matched like `git commit` (harmless, rare).
- GitHub remote not created yet; waiting for the repo name.
- The other two developers must run `git config core.hooksPath .githooks` once per clone and have Node.js installed.
