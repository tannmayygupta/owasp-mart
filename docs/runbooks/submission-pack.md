# Runbook: submission pack for the college report (story 8.6, L-31)

Goal: know, in one command, that everything the report needs from the repository is present, non-empty and free of secret-looking content. The report itself is written from these documents (the college template is still pending, see `docs/report/`).

## The check

```powershell
node scripts/check-submission-pack.mjs
```

Exit code 0 prints `submission pack: PASS`. Any FAIL line names the item and the file. The check reads only; it prints the file and line of a secret-looking hit and never the matched value. `--root <folder>` checks another copy of the repository (for example the folder you zip).

## What the pack must contain

The list lives in `scripts/check-submission-pack.mjs` (`REQUIRED`); this table is the same list, with where each item feeds the report.

| Item | Path | Feeds the report section |
|---|---|---|
| Decision log and open questions (source of truth) | `initial.md` (Section 15 decisions) | Decisions, scope, open items |
| Project rules (how the work was done) | `CLAUDE.md` | Method |
| Requirements | `docs/prd/PRD.md` | Requirements |
| Architecture, six parts | `docs/architecture/01` to `06` | Design |
| Decision records | `docs/adr/NNNN-*.md` (at least 10) | Design decisions with research sources |
| Dev-log, one per task | `docs/dev-log/YYYY-MM-DD-*.md` (at least 10) | Implementation diary, problems met |
| Traceability matrix | `docs/traceability.md` | Requirement to code to test to result |
| Changelog | `CHANGELOG.md` | What changed and when |
| Evidence | `docs/assets/<task>/` (at least 5 files) | Test results, screenshots (redacted) |
| Runbooks | local demo, backup and restore, laptop fallback, VM-I hardening, demo 19 Oct, this one | Operation and recovery |
| Handoffs | `docs/dev/HANDOFFS.md` | Team coordination |

Scanned for secret-looking content: those same folders and files. The patterns are narrow on purpose (private key blocks, AWS key ids and secret keys, GitHub and Slack tokens, JWTs, a flag-shaped value that is not one repeated letter, a `password`/`secret`/`token` assignment with a long random value). The repository's fake development values ("...-not-a-secret") and the test flags made of one repeated letter do not match. This check is in addition to `node scripts/scan-secrets.mjs`, `node scripts/scan-flags.mjs` and `node scripts/check-text-files.mjs`, which stay the gates for commits.

## Steps for you (before you hand the pack in)

1. Everything merged to the branch you submit; `git status --short` prints nothing.
2. `node scripts/check-submission-pack.mjs` is PASS. Fix FAIL lines: a missing or short document is written by the owner of that stream (do not pad a file to pass the check).
3. Run the other three scans (`scan-secrets`, `scan-flags`, `check-text-files`); all must pass.
4. Open the traceability matrix and look at every row marked "developer's live result": each must now hold your real result, or the report must say "not run". Never leave an optimistic placeholder.
5. Screenshots: only under `docs/assets/`, with addresses, account ids and names redacted.
6. Make the archive from the committed tree, not the working folder: `git archive --format=zip -o $HOME\vulnmart-submission.zip HEAD` (outside the repository). It contains no `.git`, no untracked files and no ignored files such as local keys.
7. Check the archive does not contain what it must not: `tar -tf $HOME\vulnmart-submission.zip | Select-String "\.pem|\.tfvars|\.env|\.dump"` prints nothing.
8. Record in a dev-log which commit was submitted and when.

## Not covered by the check
The quality of the text, whether the live results are true, the college template layout (pending), the Excel tracker `docs/bmad/VulnMart-Tracker.xlsx` (hand-maintained), and anything outside the listed folders. The check cannot know that a document is correct, only that it exists and is not empty or leaking.
