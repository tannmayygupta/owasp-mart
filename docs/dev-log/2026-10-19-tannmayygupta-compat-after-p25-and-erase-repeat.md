# COMPAT.md follows Akshay's P-25, and erase is tested to be safe to repeat

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-compat-p25-and-erase-repeat |
| Status | Done |
| Report tag | contracts, L-09, H-145 |

## Requirements covered
L-09 (tag preconditions), H-145 (story P-25), D-37.

## Summary
Akshay merged P-25 (deletion workflow, IF-1 1.1.0, DB 2.1.0). `contracts/COMPAT.md` still listed IF-1 1.0.0 and DB 2.0.0, so `tag-contracts --dry-run` failed `versions` again. COMPAT.md now follows the changelog and the approval rows of IF-1 and DB carry the new versions as `pending`. His handoff H-145 asks stream L only that `LabRuntime.erase` stays safe to repeat: a test now proves two calls on one attempt.

## Why
The tag needs COMPAT.md equal to the newest changelog entries (ADR 0029, amended 2026-10-19).

## What was built
COMPAT.md versions and rows; a `registry change:` line in the engine section of `contracts/CHANGELOG.md`; one test; the answer in H-145.

## How it works
Nothing new: the checker compares the Versions table with the newest changelog entry of each contract.

## Files changed
`contracts/COMPAT.md`, `contracts/CHANGELOG.md`, `apps/api/tests/test_lab_runtime.py`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `CHANGELOG.md`.

## Decisions made
None. The approval rows reset to `pending` only where they were `approved` for another version (none for IF-1 and DB this time).

## Tests
- `test_lab_runtime.py::test_erase_is_safe_to_repeat_as_the_deletion_workflow_and_the_retention_job_both_call_it` passed.
- `node scripts/tag-contracts.mjs --dry-run`: see the pull request; `check-contract-rules`: see the pull request.

## Evidence
Command output in the pull request.

## Problems met and how they were fixed
None.

## Security notes
None.

## Limitations and follow-ups
The sign-offs and the checklist lines of L-09 are still open (H-352).