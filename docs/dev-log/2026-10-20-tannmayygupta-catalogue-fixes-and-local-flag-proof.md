# Catalogue fixes and a local proof that every challenge shows its own flag

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | catalogue, hints, flag capture, local end-to-end |

## Requirements covered
C01 to C11, FR-HNT-01, FR-HNT-02. Story: `docs/bmad/initiative-lab/backlog/story-catalogue-fixes-and-local-flag-proof.md`.

## Summary (plain language, 3-5 lines)
I merged Akshay's finished work from `main`, fixed the catalogue gaps from the audit, and wrote a script that starts the real shop like an instance, plants a new flag for each of the 11 challenges, runs every exploit and checks the right flag comes back. It does: 35 of 35 checks pass on Linux, with no challenge showing another challenge's flag.

## Why
The developer asked to pull Akshay's changes, to take over the shop work, to fix all gaps and to see every challenge show its correct flag.

## What was built
- Merge of `origin/main` (Akshay's P-30, P-31, P-32, P-08 and story 5.3) into this branch; the only conflict was `CHANGELOG.md` (both sides kept).
- Catalogue: C06 title is now "Software Supply Chain Failures", C09 "Security Logging and Alerting Failures" (official OWASP 2025 names, checked at top10.owasp.org/2025); C06 milestone signals now name `import.job` events and the flag in the preview response; hint 3 of C02 and C04 now gives a direction to test.
- `scripts/e2e-local-flags.mjs` (and `--docker`): builds the seeded snapshot, runs the real injector with one fresh flag per challenge, starts the shop in instance mode, the import service and the mock services, runs each exploit module and checks the right flag comes back.

## How it works
The run uses the same injector, snapshot and shop code as an instance. The flags are made in the script (never real ones). A fetch wrapper records every flag-shaped value an exploit sees. Per challenge it checks three things: the exploit holds, this challenge's flag came back, no other challenge's flag came back. C03 means part A (the SQL injection) here; part B needs the support bot and has its own test.

## Files changed
- `challenges/catalog/c02.yaml`, `c04.yaml`, `c06.yaml`, `c09.yaml` — wording and titles.
- `scripts/e2e-local-flags.mjs`, `scripts/e2e-local-flags.test.mjs` — the proof and its helper tests.
- `docs/bmad/initiative-lab/backlog/story-catalogue-fixes-and-local-flag-proof*.md`, `docs/traceability.md`, `CHANGELOG.md`, this file, and a correction in `docs/dev-log/2026-10-20-tannmayygupta-challenge-audit.md`.

## Decisions made
No ADR. The developer's instruction to take over the shop and challenge work is recorded in the story notes; `initial.md` was not edited (the developer confirms decision changes).

## Tests
- `git fetch origin`, `git merge origin/main` — 19 commits merged; `node scripts/verify-skills.mjs` — OK, 217 files match.
- `pnpm run catalog:check` — OK, all 11 entries validate. `node --test scripts/validate-catalog.test.mjs` — 13 pass. `pytest apps/api/tests/test_lab_api.py apps/api/tests/test_lab_runtime.py` — 51 passed.
- `node scripts/e2e-local-flags.mjs --docker` (Linux CI image, real unix socket) — 35 PASS, 0 FAIL: the injector plants all 11 flags; for each of C01 to C11 the exploit works, its own flag comes back, and no foreign flag comes back.
- `node scripts/e2e-local-flags.mjs` on Windows — C01 to C11 except C06: all PASS (first run 32 PASS, 3 FAIL: C03 picked the bot-dependent part B, fixed; C06 cannot run, see Problems). With `--only C01,C06`: 5 PASS, C06 prints SKIP.
- `node --test scripts/e2e-local-flags.test.mjs` — 3 pass.
- Not run: the platform side (sidecar event, score, pasting the flag) with the real shop on a local platform stack; C03 part B was not re-run here.

## Evidence
Output of the commands above (flags are never printed).

## Problems met and how they were fixed
- C06 on Windows: this PC refuses to create any unix socket (`EACCES` in every folder), and a Windows named pipe does not support the half-close the import service's protocol needs. The repo's own tests skip for the same reason and run in CI. Fix: the script skips C06 on Windows and offers `--docker`, which runs the same proof in the Linux CI image.
- My first idea (a named pipe) was a dead end: the service accepted the connection but never answered.
- The first Windows run for C03 loaded the part B exploit (needs the bot); the script now uses part A for C03.

## Security notes (vulnerable parts only)
No real flag is read or written; the flags are made per run and the script prints none. Nothing in the platform was weakened; the exploits run against the shop only.

## Limitations and follow-ups
- Not proved locally: sidecar credit, score and paste check with the real shop (only the live script does this).
- Shop UI is still the old one: next story.
- Stream T documents (`docs/dev/dev3-sahil.md`, `initiative-target`) are unchanged; the developer decides what to do with them.
