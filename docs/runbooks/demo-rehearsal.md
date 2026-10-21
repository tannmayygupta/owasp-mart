# Demo rehearsal checklist and record (tracker task L-31)

Status: **not rehearsed.** This file is the script and the form. Nothing in it records a rehearsal; the leader fills the record sections when he runs one. The rehearsal never ran
before 2026-10-21 (tracker audit, L-31). It must run twice: once on the laptop fallback (`docs/runbooks/laptop-fallback.md`) and once on the deployed site.

Related: `docs/runbooks/demo-19-oct.md` (the earlier demo plan), `docs/runbooks/local-demo.md`, `docs/runbooks/live-deploy.md`, `docs/runbooks/live-e2e-journeys.md`, `scripts/check-submission-pack.mjs`.

## Before anything (10 minutes, both runs)

| # | Check | Command or place | Pass when |
|---|---|---|---|
| P1 | Skills and records are sound | `node scripts/verify-skills.mjs`, `node scripts/check-records.mjs` | both exit 0 |
| P2 | The deployed site is the current build | `node scripts/verify-deployed.mjs --base https://<platform host>` | no FAIL |
| P3 | The role journeys pass | `docs/runbooks/live-e2e-journeys.md` | exit 0 |
| P4 | The learner journey passes | `node scripts/e2e-live.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p>` | exit 0 |
| P5 | Capacity is free | `node scripts/live-free-test-instances.mjs` (dry), the admin capacity view | no leftover instances |
| P6 | Mail is visible | Mailpit on VM-P (ssh tunnel), the page loads | the last mail is shown |
| P7 | Accounts ready (never typed by Claude) | the leader's own: one learner, one recruiter (active, terms accepted), the admin with the authenticator at hand | each signs in |
| P8 | Backup of the demo data | `docs/runbooks/backup-and-restore.md` | the file exists off the VM |
| P9 | Screen, sound, network, a second device with the candidate's mail address | physical | works |

## The script (what is shown, in order, with the time box)

| Step | Who | Show | Say (one sentence) | Time | Fallback if it breaks |
|---|---|---|---|---|---|
| 1 | learner | Sign in to the lab console, the catalogue of 11 challenges, Start a practice run, the shop opens | Practice is free and isolated, one instance per person | 4 min | the recorded run of `scripts/e2e-live.mjs` |
| 2 | learner | Begin the first challenge (countdown), a hint, paste a wrong and the right flag | The platform checks flags per instance; hints are free in practice | 4 min | skip the hint |
| 3 | recruiter | Create a template (time limit, results after release), invite the candidate | The company decides rules; the invite is a single-use link | 3 min | use the pre-made template |
| 4 | candidate | Open the mail, the invite page, accept, consent, Start | Consent is explicit and the clock starts when the instance is ready | 4 min | the second device |
| 5 | candidate | Find a flag in the shop, paste it, submit | Evidence is captured; nothing in the report holds a flag | 5 min | the seeded attempt |
| 6 | recruiter | Live view of the candidate, then the report, the timeline, release the results | The recruiter sees evidence; the candidate sees the score only after release | 4 min | the recorded report |
| 7 | admin | Queue, users, capacity, audit log; break-glass shown by its refusal without a reason | Admin access is audited and cannot read candidate answers silently | 3 min | the scenario matrix A-15 to A-17 |
| 8 | all | The scenario matrix and the ASVS checklist | What is proved, what is open and who owns it | 2 min | print them |

Total about 29 minutes plus questions. Do not show anything the matrix marks as missing or partial (write-ups and their similarity review, the admin dashboard of package F, the recruiter buttons of package F) as if it worked.

## Record of one rehearsal (copy this block for each run, fill it in by hand)

```
Date:                       Run: laptop fallback | deployed site
Who ran it:                 Build or commit shown on the site:
Start time / end time:      Network:
Pre-checks P1 to P9:        pass / fail per line (name the failed one)
Step 1 to 8:                pass | fail | skipped, seconds taken, what happened
Problems met:               what, what was done, what is still open
Fallbacks used:             which step, why
Decision:                   ready for the audience | not ready, because ...
```

Pass/fail rules: a step passes only when it was shown to the end without a command typed off-script. A fallback used counts as a fail of that step even when the demo went on.

## Record

| Run | Date | Result | Where the notes are |
|---|---|---|---|
| 1 laptop fallback | not run | - | - |
| 2 deployed site | not run | - | - |

`scripts/check-submission-pack.mjs` only counts files; it does not check that a rehearsal happened. Fill the table above and the dev-log with the leader's real result before ticking L-31.
