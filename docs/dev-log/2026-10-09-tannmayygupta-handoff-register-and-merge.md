# Handoff register, early merge of the L-03 branch and a line-ending fix

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay (local, not pushed) |
| Status | Done |
| Report tag | process, hand-offs between streams |

## Requirements covered
D-30 (trackers), D-33 (streams), D-37 (review optional), D-38; story hand-offs of L-02, L-03, L-04.

## Summary (plain language, 3-5 lines)
Three contracts (instance, events, orchestrator) came out with many "to confirm" rows for Akshay and Sahil. They are now one register, `docs/dev/HANDOFFS.md` (82 rows, each with a task, a source, a default and a status), pointed to from every affected task in the three task files. A new rule in `CLAUDE.md` makes Claude read the rows addressed to a task when the developer plans it. The L-03 branch was merged into the sprint branch early, and a Windows line-ending problem found on the way was fixed.

## Why
The user asked that the open items either be fixed or become something Akshay and Sahil's Claude sessions pick up automatically when they implement their tasks.

## What was built
- `docs/dev/HANDOFFS.md`: How this works, three tables (Akshay 23 rows, Sahil 33 rows including one per challenge C01 to C11, Tanmay 26 rows of carry-over), and a done checklist before the contracts tag (L-09). Every open-points row of the three contracts maps to at least one handoff.
- One `Handoffs:` line under each affected task in `dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md` (46 tasks); Step 2a in `docs/dev/START-HERE.md`; rule 2b in the task cycle of `CLAUDE.md`.
- Merge of `shared-L-03` into `sprint-1-tanmay` with the conflicts resolved: three contracts side by side, `contracts:check` runs all three checks, decisions D-36 to D-38 in order, one traceability row per task.
- `.gitattributes` pins LF for `contracts/**`, `apps/**`, `*.py`, `*.json`, `*.yaml`, `*.toml` and the lockfiles.

## How it works
A handoff row says what to confirm, decide or build, the default that stands if nothing is said, and the source (contract row, ADR or decision). The task owner's Claude reads the rows for the task, puts them into the plan, asks the developer, and writes the answer in the row. A task that makes a proposal other developers depend on adds a row for them in the same commit.

## Files changed
`docs/dev/HANDOFFS.md` (new), `docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`, `docs/dev/START-HERE.md`, `CLAUDE.md`, `.gitattributes`, `scripts/e2e/events.e2e.test.mjs`, and the merged `CHANGELOG.md`, `README.md`, `contracts/CHANGELOG.md`, `docs/traceability.md`, `docs/adr/README.md`, `initial.md`, `package.json`, `scripts/e2e/contracts.e2e.test.mjs`.

## Decisions made
No new decision. The register carries 82 proposals as written in the contracts; the gaps found while writing it are rows marked "no proposal yet: needs a decision".

## Tests
After the merge and the line-ending fix, on Tanmay's PC (real output): `node --test "scripts/*.test.mjs"` 82 of 82; `uv run --locked --package vulnmart-api pytest -q` 204 passed; `node --test` of `contracts.e2e`, `events.e2e` 18 of 18 (one failed before the fix, see below) and `dev.e2e` 10 of 10 once Docker Desktop was started; `pnpm run contracts:check` passes for all three contracts; `pnpm install --frozen-lockfile`, `uv lock --check`, `pnpm audit` and `node scripts/verify-skills.mjs` clean.

## Evidence
Command output above; the register itself.

## Problems met and how they were fixed
- After the merge, git (`core.autocrlf=true`) rewrote the contract files with CRLF, and the byte-comparing test "--write-posted leaves the committed posted schema unchanged" failed. This would fail on Sahil's Windows PC too. Fixed at the cause (`.gitattributes` LF pins) and in the test (compares with line endings normalised).
- While refreshing the working tree, a batch `git checkout` failed with "filename or extension too long" after the working copies had been deleted; a plain `git checkout -- .` restored all 538 files from the index (nothing uncommitted was lost; checked with `git status`).
- Ten Docker end-to-end tests failed fast only because Docker Desktop was not running after the restart; they pass once it is started.
- Merge conflicts: three files had two good sides; both were kept, the 0.1.1 entry of the instance contract was moved back into its own section, and a duplicate traceability row was removed.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
- The register found gaps in the contracts themselves, all marked "no proposal yet: needs a decision": the owner hash for the `vm.owner` label has no field in IF-5 (H-20), the starting `seq` after a reset has no field in IF-5 (H-59), how an event leaves the import service with no network (H-50), who writes the events-table migration (H-07), who is the orchestrator client (H-11), who writes the lab-port protocols (H-06, H-79), key derivation and distribution (H-09, H-10), the flag recomputation input (H-21), and CI does not run the end-to-end tests (H-73).
- Akshay and Sahil still have to be told in the team chat that the register exists.
- The CI run on a pull request has not happened yet (the Python and contract steps are new).
