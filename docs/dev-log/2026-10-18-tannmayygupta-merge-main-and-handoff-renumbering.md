# Merge of main into sprint-3-tanmay and the handoff id collision

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done (merge prepared before the pull request) |
| Report tag | integration, merge |

## Summary
Before opening the pull request for L-12, a trial merge (`git merge-tree`) showed two conflicting files; `main` had moved by 13 commits (Akshay's PRs up to #23). Both conflicts were append-only (CHANGELOG.md, docs/dev/HANDOFFS.md) and were resolved by keeping both sides. A deeper problem was found while reading the incoming rows: both streams had created handoff rows H-127 to H-134 independently with different meanings. Stream L's rows (H-127 to H-147, 21 rows) were renumbered +200 (H-327 to H-347) on the lines the branch added only (199 lines in 60 files, including code comments), so stream P's ids and references stay valid.

## Tests (real results)
- Trial merge: conflicts in CHANGELOG.md and docs/dev/HANDOFFS.md only; compose.yaml, uv.lock, pyproject.toml, traceability.md and dev1-tanmay.md auto-merged.
- After the fix: 155 handoff rows, 0 duplicate ids, 21 stream L rows in the 3xx range, stream P's H-127 to H-134 present with his text.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: PASS. `uv lock --check`: resolved 78 packages, no change needed.

## Problems met and how they were fixed
- The id collision was invisible in git (the two sides added different text at the same place); found by reading the incoming rows.
- A read-only verification command was refused once by the auto-mode safety check; it was retried as a smaller read-only command.

## Limitations and follow-ups
Old references to stream L's H-127 to H-147 outside the repository (chat messages) mean the +200 id. Stream L's rows from this branch were the only ones renumbered; ids H-01 to H-126 are unchanged. The full test suites are run after the merge (see the commit message).
