# Project progress page for the guide meeting (story 1.14)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, on top of e2f7cfd; not committed when this entry was written (the developer commits) |
| Status | Partly done: generator, tests, snapshot and README written and run on this PC; the story is not marked done and the task file is not changed until the developer confirms |
| Report tag | demo readiness, documentation, tooling |

## Requirements covered
LX-3 (partial: only the progress page for the guide meeting; the demo rehearsal L-31 is open), D-37.

## Summary (plain language)
The three developers meet their college guide and need to show what VulnMart is, that it is achievable and that three people are building it. A small script now reads the three task files and produces one offline web page: what we are making, how a session works in six steps, what already runs (each box names the file that records the result), and one section per stream with every task marked Done, Being implemented or Next.

## Why
Until now the progress existed only as markdown files and terminal output. Source: the story plan `docs/bmad/initiative-lab/epic-lab-baseline/story-project-progress-page-for-the-guide-meeting-plan.md` (decisions confirmed by the developer on 2026-10-11).

## What was built
- `scripts/progress-page.mjs`: parses `- [x] **ID. Title**` lines and `## Sprint N (D Mon to D Mon YYYY)` headings, computes the status by the plan's rules, renders one HTML file (inline CSS, no script, no external reference), writes it (`--out`) or serves it (`--serve`, `127.0.0.1` only, default port 8088, only `/` answers, other paths 404, other methods 405). `--dev1`, `--dev2`, `--dev3` accept a file path or a git ref (read with `git show <ref>:<task file>`). `--today` is for tests, `--root` points at another repository folder.
- Exit codes: 0 ok; 1 a task file has no tasks; 2 bad argument, missing file or ref, or port in use. No page is written on an error.
- `scripts/progress-page.test.mjs`: 17 tests, one or more per row of the plan's matrix (temporary folders and a temporary git repository for the ref case).
- `docs/progress/index.html` (snapshot generated with the working-tree task files), `docs/progress/README.md`, `package.json` script `progress`.

## How it works
Status rules: ticked is Done; unticked in the sprint whose dates include today is Being implemented; unticked in an earlier sprint is Being implemented (late); unticked in a later sprint is Next. The script only reads; it never edits a task file or a tracker. The page content (six steps, proof boxes, contracts table) is fixed text in the script. Every proof box lists its source file; the numbers were copied from these files: the stub-shop dev-log and `docs/assets/l-06-stub-harness/harness-run.txt` (20 rules, harness PASS), the contract-checks dev-log and the audit dev-log (four contracts PASS, 17 PASS / 0 FAIL / 4 NOT-APPLICABLE, 434 unit, 393 pytest, 61 end-to-end), the AWS hosts dev-log with `verify-hosts.txt` (94 checks) and `private-link-check.txt` (22 checks), the repository skeleton dev-log (`dev.mjs hello`). Contract names and owners come from `docs/architecture/07-repo-and-workstreams.md`.

## Files changed
- `scripts/progress-page.mjs`, `scripts/progress-page.test.mjs` (new)
- `docs/progress/index.html`, `docs/progress/README.md` (new)
- `package.json` (script `progress`), `CHANGELOG.md`, `docs/traceability.md` (new section with row LX-3), this dev-log
- Not touched: `README.md`, `image.png`, any task file or tracker.

## Decisions made
None new. No ADR (small generator, plan decisions already confirmed on 2026-10-11).

## Tests
Real runs on this PC (Windows, Node), 2026-10-11:
- `node --test scripts/progress-page.test.mjs`: 17 tests, 17 pass.
- `node scripts/progress-page.mjs --today 2026-10-11`: wrote `docs/progress/index.html`.
- `node scripts/progress-page.mjs --dev3 origin/sprint-1-sahil --out <temp file>`: Sahil showed 6 done (his branch), against 0 done from the working tree.
- `node scripts/progress-page.mjs --dev3 origin/nope --out <temp file>`: exit 2, message names the stream and the ref, no file written.
- Serve check: the server was started, `GET http://127.0.0.1:8088/` returned 200 (49787 bytes, sections Lab, Platform and Target present), `GET /other` returned 404, the only listener was 127.0.0.1:8088, and after the process was stopped nothing listened on 8088.
- `node scripts/check-text-files.mjs`: PASS (exit 0). `node scripts/scan-secrets.mjs`: PASS (exit 0).
Traceability: LX-3 (partial).

## Evidence
Command outputs above; no screenshots.

## Problems met and how they were fixed
- None in the build. Note: the working-tree task files of Akshay and Sahil show no ticks because their work is on their own branches; the page shows it when run with `--dev2` and `--dev3` and a git ref.

## Security notes (vulnerable parts only)
Not applicable (no vulnerable lab code). The server is read-only, binds to 127.0.0.1, serves one path, sends a content security policy that forbids scripts, and every task title is escaped.

## Limitations and follow-ups
- Not run by me, by instruction: docker, terraform, ssh, `ci:linux`, the full suites.
- The proof boxes are fixed text: when a result changes, update the box and its source line.
- The sprint-1 pull request is the one that will merge this; the tick, tracker state and the Excel sheet are left to the developer after confirmation (set Done = Yes in the Excel sheet when it applies).
