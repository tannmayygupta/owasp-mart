---
title: 'Project progress page for the guide meeting'
type: 'feature'
ticket: '14'
created: '2026-10-11'
status: 'in-progress'
baseline_revision: '0cb7b84'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: 'none'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The three developers meet their college guide tomorrow and must show, on a laptop, what VulnMart is, that it is achievable, and that the Lab, the Platform and the Target are being implemented by three people. Today that exists only as markdown files and terminal output.

**Approach:** A small local website, generated from the three developers' own task files, with a home page (what we are building and how it works), a proof page (what already runs, with the commands) and one page per stream (Lab, Platform, Target) listing each task as done, being implemented or next. No charts, no dependency, no secret, no hosting.

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-11: the page runs on the developer's laptop (`127.0.0.1`), no charts or progress bars, plain status words, the aim is "what we are making, it is achievable, it is being implemented". Statuses come only from real data: a task is **Done** when its checkbox is ticked in the owner's task file; **Being implemented** when it is unticked and belongs to the sprint whose dates include today; **Next** when it belongs to a later sprint; an unticked task of an earlier sprint is **Being implemented (late)**. Each stream's task file can be read from that developer's own git branch (`--dev1`, `--dev2`, `--dev3` take a working-tree path or a git ref such as `origin/sprint-1-sahil`), so progress shows before the branches are merged. The "what already runs" boxes only list commands that exist in the repository today, with the result recorded in a dev-log or evidence file (no invented output). The page works offline: one HTML file with inline CSS, no external fonts, scripts or images. English text. Output: a static `docs/progress/index.html` (generated, committed as a snapshot with its date) and a tiny server for `--serve` (Node built-ins, binds to `127.0.0.1` only, default port 8088, read-only, serves only that page).

**Never:** No external dependency, no network call, no secret, account ID, address or personal data, no claim of a result that no evidence file shows, no live control of Docker or AWS from the page, no change to any task file or tracker by the script, no hosting on the AWS servers, no push, no pull request.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal | three task files in the working tree | one page, three stream pages, statuses by the rules above | exit 0 |
| Branch ref | `--dev3 origin/sprint-1-sahil` | Sahil's ticks come from that branch | exit 0 |
| Ref missing | unknown git ref or file | exit 2 with the name of the stream and the ref | no partial page written |
| Task file malformed | no task lines found for a stream | exit 1 naming the stream | no page written |
| Today inside a sprint | date in sprint 1 | unticked sprint 1 tasks are "Being implemented", later ones "Next" | — |
| Today after a sprint | date later than a sprint's end | its unticked tasks are "Being implemented (late)" | — |
| Serve | `--serve` | `127.0.0.1:8088` answers 200 with the page; any other path 404; port in use exits 2 with a message | no listener on other interfaces |
| Escaping | a task title with `<`, `&` or quotes | shown as text, never as markup | — |
| Same input twice | unchanged files | identical output (apart from the generation date line) | — |

</frozen-after-approval>

## Code Map

- `docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`: lines `- [x] **L-01. Title**` (ids L-, P-, T-), `## Sprint N (D Mon to D Mon YYYY)` headings, `  - Build:`, `  - Done when:` and `  - Waits on:` lines under each task.
- `docs/dev-log/*` and `docs/assets/*`: sources of the "what already runs" boxes (harness PASS 20 rules, `verify-hosts` 94 checks, `private-link-check` 22 checks, contract checks, CI jobs, Sahil's shop and exploit runner as recorded in his dev-logs, only if present in the repository).
- `docs/architecture/07-repo-and-workstreams.md` (streams, contracts IF-2, IF-4, IF-5, IF-6, IF-7), `README.md` and `initial.md` (what VulnMart is, in the project's own words; do not edit README.md).
- Existing script style: `scripts/dev.mjs` (arguments, exit codes, help text), `scripts/check-text-files.mjs` and tests (`node:test`), `scripts/ci-linux.mjs` (the CI mirror guard: new tests are picked up by `node --test "scripts/*.test.mjs"`).
- New: `scripts/progress-page.mjs`, `scripts/progress-page.test.mjs`, `docs/progress/index.html` (snapshot), `docs/progress/README.md` (how to run it).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/progress-page.mjs` -- parse task files (path or git ref), compute statuses by the rules, render the home, proof and three stream pages as one HTML file with simple navigation (anchors or small inline script-free tabs), `--serve`, `--out`, `--today YYYY-MM-DD` (for tests), help text, exit codes
- [ ] `scripts/progress-page.test.mjs` -- one test per matrix row on fixture task files in a temporary folder (including a temporary git repository for the ref case and the escaping case)
- [ ] Content: home text, "how it works" in six plain steps, proof boxes from existing evidence, per-stream purpose lines, "contracts between the streams" table from architecture 07 (names and owners only)
- [ ] `docs/progress/README.md` and `package.json` script `progress` (`node scripts/progress-page.mjs --serve`); dev-log, CHANGELOG line, traceability row LX-3 (partial), tracker via the plan; generate and commit the snapshot with the current task files
- [ ] Verify by running the server and fetching the page (real output), then the text check, secret scan and unit tests

**Acceptance Criteria:**
- Given the three task files, when the script runs, then every task of every stream appears once with the right status and nothing else.
- Given `--dev3 origin/sprint-1-sahil`, when run, then Sahil's ticks from that branch are shown.
- Given `--serve`, when the page is requested on 127.0.0.1, then it answers 200 and no other interface listens.
- Given a hostile title, when rendered, then it is escaped.
- Given the page, when read by a non-technical visitor, then it states what VulnMart is, how a session works in six steps, what already runs, and what each of the three developers is implementing.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Review none by decision: small generator, no security surface, needed tomorrow; the sprint audit of 2026-10-11 is the review input for the facts it shows.

## Verification

**Commands:**
- `node --test scripts/progress-page.test.mjs` -- expected: all pass
- `node scripts/progress-page.mjs --out docs/progress/index.html` and `node scripts/progress-page.mjs --serve` then fetch `http://127.0.0.1:8088/` -- expected: 200 and the three streams
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` -- expected: PASS
