# Contract checks live in CI (story 1.6, task L-07)

| Field | Value |
|---|---|
| Date | 2026-10-10 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, committed as dc5c8bd (work started on top of b0a55cd); not pushed |
| Status | Done: built and tested locally and in the Linux container; L-07 closed and ticked by the developer on 2026-10-11; the first GitHub run of job `contract-rules` has not happened (tracked in `docs/dev/sprint-1-pr-checklist.md`) |
| Report tag | contract rules, CI, breaking-change check |

## Requirements covered
L-07, NFR-MNT-02, NFR-MNT-04, NFR-MNT-05, D-14, D-37, architecture 07 section 5 and rules 3, 4, 8, 9; handoffs H-73 (answered), H-81, H-84, H-91 (read); new handoffs H-95 to H-99. Report row LB-7.

## Summary (plain language)
CI now has a job `contract-rules` that runs one command, `node scripts/check-contract-rules.mjs`, on every pull request. It reads `contracts/registry.json` and checks that a contract change updates its changelog section and its mock, that no breaking change is slipped in without a BREAKING line and a raised version, that no new folder under `contracts/` is unregistered, and the shared rules (table owners, one Alembic head, COMPAT.md, bundle). Checks whose inputs do not exist yet print NOT-APPLICABLE with the missing path and are counted.

## Why
Before this, CI validated each contract's own files but nothing stopped a pull request from breaking a contract silently (plan of story 1.6; handoff H-73; architecture 07 section 5).

## What was built
- `tools/oasdiff.json`, `scripts/oasdiff.mjs`: oasdiff 1.33.0 pinned with sha256 of every archive and binary; fetched into git-ignored `tools/.bin/`; refuses a wrong checksum; fixed flags `--allow-external-refs=false --fail-on ERR`.
- `scripts/schema-diff.mjs`: our own JSON Schema breaking diff using the CHANGELOG rule.
- `contracts/registry.json` and `scripts/check-contract-rules.mjs`: the rule set, base ref logic (explicit base, else latest `contracts-v*` tag, else `origin/$GITHUB_BASE_REF`, else `origin/main`; merge base with HEAD), PASS, FAIL and NOT-APPLICABLE output and a job summary.
- `scripts/check_table_owners.py` with the proposed `contracts/db/table-owners.schema.json`; `scripts/check_alembic_head.py`; COMPAT.md and bundle checks inside the main script, each with a proposed format.
- CI job `contract-rules`, a mirror step in `scripts/ci-linux.mjs`, `pnpm run contracts:rules`.

## How it works
The head side of every comparison is the working tree, the base side is `git show <merge-base>:<path>` (CRLF and LF count as equal). Per registered contract: any changed file needs a new line in its section of `contracts/CHANGELOG.md`; a changed schema or OpenAPI file needs a changed file under its mock paths or a line `no mock change: <reason>`; breaking findings (oasdiff for `.yaml`, `schema-diff.mjs` for `.json`) need a line marked BREAKING plus a raised version (minor before v1.0.0, major after). A new file is reported and not compared; a deleted one is breaking. NOT-APPLICABLE is used only when the input path does not exist (or, for a contract, when the registry lists no mock paths).

## Files changed
- `tools/oasdiff.json`, `scripts/oasdiff.mjs`, `scripts/schema-diff.mjs`, `scripts/check-contract-rules.mjs`, `scripts/check_table_owners.py`, `scripts/check_alembic_head.py`: new.
- `contracts/registry.json`, `contracts/db/table-owners.schema.json`: new.
- `scripts/oasdiff.test.mjs`, `scripts/schema-diff.test.mjs`, `scripts/check-contract-rules.test.mjs`: new tests; `scripts/ci-linux.test.mjs` extended.
- `.github/workflows/ci.yml` (job `contract-rules`; in job `scripts` the uv setup moved before the unit tests because the new tests run the Python checks through uv), `scripts/ci-linux.mjs` (step `contract-rules`, `.git` now copied into the container, `tools/.bin` excluded, `safe.directory`), `package.json` (`contracts:rules`), `.gitignore` (`tools/.bin/`).
- `contracts/CHANGELOG.md` (rule note, new section Table owners (DB)), `docs/adr/0012-monorepo-and-contract-toolchain.md` (update), `docs/dev/HANDOFFS.md` (H-73 answered, H-95 to H-99 added), `CHANGELOG.md`, `docs/traceability.md`.

## Decisions made
Recorded as an update of ADR 0012 (oasdiff verified and adopted, own JSON Schema diff). Decisions of 2026-10-10 by the developer are in the plan. Choices made while building (proposals, for the developer to confirm): the registry fields; the waiver form `no mock change: <reason>` is read from the new changelog lines; a schema or OpenAPI file counts as "machine-readable" for the mock rule, a change to a `.md` or an example needs only a changelog line; a removed file is breaking; the pinned binary checksums are also pinned per extracted binary.

## Tests
Real runs on 2026-10-10 (Windows host, Node 24.11.0):
- `node --test scripts/check-contract-rules.test.mjs scripts/schema-diff.test.mjs scripts/oasdiff.test.mjs scripts/ci-linux.test.mjs`: 111 of 111 pass after the review patches (output in `docs/assets/l-07-contract-checks/new-tests.txt`).
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"`: 335 of 335 pass after the review patches.
- `pnpm run contracts:check`: PASS (instance, events, orchestrator 8 operations, lab 18 operations).
- `uv run --locked --package vulnmart-api pytest -q`: 393 passed.
- `node scripts/check-contract-rules.mjs --base origin/main`: exit 0, 16 PASS, 0 FAIL, 5 NOT-APPLICABLE (`real-sprint-diff.txt`). Against `origin/main` the lab, orchestrator, events and sidecar-start files are new files, so they are reported and not compared; the real comparison against an earlier base was not possible on this branch.
- Demonstration: a temporary break of the orchestrator OpenAPI file (a removed enum value) against `HEAD` gave exit 1 with FAIL on changelog, mock and breaking (`demo-breaking-change-fails.txt`); the file was restored.
- `pnpm run ci:linux` (Docker, Linux): all 10 steps PASS including `contract-rules` (re-run after the review patches) (`ci-linux.txt`).
Every row of the matrix of the plan has a test on a temporary git repository (or fixture) that fails on the broken input and passes on the valid one. Traceability row LB-7.

## Evidence
`docs/assets/l-07-contract-checks/`: `new-tests.txt`, `real-sprint-diff.txt`, `demo-breaking-change-fails.txt`, `ci-linux.txt`.

## Problems met and how they were fixed
- GNU tar on the Windows PATH read `C:` in the archive path as a remote host: the extraction now uses a relative file name and `cwd`.
- My first test for "removed response property" passed through oasdiff silently: oasdiff does not report a removed optional response property at level ERR (a required one is ERR). The test uses a required property; the gap is written in ADR 0012.
- The first real run said `contracts/mocks` had a file directly in the mock folder: the unit logic treated the mock root like a plain folder; fixed by treating it as a container.
- The new job needs `.git` in the Linux container, which `ci-linux.mjs` used to leave out; it is now copied, and `tools/.bin` is excluded so a Windows binary never leaks in.

## Security notes
No vulnerable part. The oasdiff binary is run only after its sha256 matches the pin; with no signature published, the trust anchor is the pin in this repository. External `$ref` is not followed.

## Limitations and follow-ups
- Job `contract-rules` has not run on GitHub; only the Linux container run exists.
- The tests download oasdiff (about 19 MB) on first run and need `uv` for the Python checks; the unit test step takes about 95 seconds more.
- NOT-APPLICABLE until Akshay delivers the table-owners file, the Alembic folder, COMPAT.md and the bundle command (handoffs H-95 to H-98). Not built: a check that a migration touches only tables of its own module; apply-from-empty migrations; approvals (L-09, EF-30).
- A removed optional response property in an OpenAPI file is not caught by oasdiff at ERR level.
- The mock rule for the DB contract is NOT-APPLICABLE (the registry lists no mock for it).

## Review fixes (same story, 2026-10-10)
- Rule engine: git failures, a missing merge base (shallow or unrelated history) and a missing base ref now FAIL with "fetch the full history"; no guess of the base, no empty changed set; diff with `--no-renames -z`. Files and entries of the base registry are compared too (a deleted or moved registered file is breaking even when its registry line goes; a dropped entry fails while its folder exists). Registry shape and unlisted schema or OpenAPI files fail clearly; dispatch is by registry list. The per-pull-request rules use the pull request base; the latest `contracts-v*` tag adds a second breaking comparison that needs a raised version. A changed contract needs a newly added `### X.Y.Z` entry, and BREAKING, the raised version and the waiver are read from the new entries only. Mock rule ignores Markdown, tests and whitespace. `noMock` states "no mock by design". A shared-check input that existed in the base and is gone FAILs. Timeouts, `pnpm run contracts:bundle:check`, COMPAT.md parser.
- Other scripts: Alembic merge revisions pass, `__init__.py` and revision-less files are ignored, a syntax error names the file; table owners need the module folder, accept CODEOWNERS paths in any form, reject duplicate YAML keys, FAIL without uv; schema diff treats `{}` as `true`, loosening is not breaking, `if` changes are flagged with a reason; oasdiff has a fetch timeout with retries, an atomic install, a non-list guard and a severity file that raises the removal checks to err.
- CI and docs: job `contract-rules` installs pnpm packages; `ci:linux` fails early without a real `.git` or `origin/main`; ADR 0012, handoffs and deferred-work updated; the registry fields, the waiver form, removed-file-is-breaking, the COMPAT.md format and the bundle command are written as proposals awaiting confirmation.

## Late verification notes (2026-10-10)
- A full pytest run started while other agents were running took 39 minutes and failed one test, test_the_full_lifecycle_works_over_mtls; the same test passes alone (27 of 27 in test_mtls.py, 65 s) and the full suite passes on a quiet machine (393 passed, 170 s). Treated as a load-induced timing flake; if it recurs on CI it becomes a bug story.
- Real run against the merged IF-6 v0 (--base 16ae8aa, the merge of pull request 2): exit 0 (eal-diff-vs-merged-v0.txt); against origin/main: 17 PASS, 0 FAIL, 4 NOT-APPLICABLE.
- End-to-end files: 61 of 61 pass.
