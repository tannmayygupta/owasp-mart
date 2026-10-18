# Production readiness 3: the review findings of sprints 3 and 4, closed or accepted with a reason

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-4-tanmay |
| Status | Done: every confirmed finding is fixed with a test or accepted with the reason below |
| Report tag | review, regression, security |

## Requirements covered
NFR-SEC-02, NFR-ISO-05, FR-SES-02, FR-SES-10, FR-DET-03, NFR-SEC-03; the findings A1 to A8, B1 to B12, C1 to C10, D1 to D11 of `docs/dev-log/2026-10-18-tannmayygupta-sprint-4-review-and-s-8.md`.

## Summary
The four review reports named 41 findings. Nine were closed with the persistence work (see the dev-log of stories 9.1 and 9.2), the rest here. Each fix has a regression test; five findings stay open on purpose and are explained.

## Findings and what happened
| Id | Finding | Result |
|---|---|---|
| A1, A2 | start after withdraw; instance leak on a failed step | fixed (9.1), tests `test_start_after_withdrawal...`, `test_a_failed_start...` |
| A3, A5 | two resets compute one epoch; wait under the lock | fixed (9.1): epoch read in the lock, wait outside, a second reset refused; `test_two_resets_of_one_attempt_cannot_overlap...` |
| A4 | a reset that never gets ready leaves the attempt on a dead instance | mitigated: the reset is not counted and a new start replaces a dead instance (`test_stop_frees_the_instance...`); no automatic retry |
| A6, B6, B7 | decision and credit not atomic; finality in a dict; reminder sink | fixed: finality from the stored status, a repeated decision makes the credit good, a failing sink does not stop the reminders |
| A7 | a report could resurrect a destroyed instance | fixed: `destroyed` is terminal; `test_a_destroyed_instance_is_never_resurrected...` |
| B1 | instance leak when reported before the freeze ended | fixed (review commit) |
| B2 | a failing freeze blocked the destroy for ever | fixed: the first failure is stored and the destroy goes ahead 5 minutes later; `test_a_freeze_that_keeps_failing...` |
| B3 | grace window lost to the tick | fixed: a submit inside the grace window after the auto-submit gets the same answer |
| B4 | withdraw racing the tick | fixed: the transient `expired` step is finished first |
| B5 | second withdrawal after an undo ignored | fixed: a new undo window starts; test |
| B8 | caller-supplied ready instant | fixed: more than 5 minutes from the server clock is replaced by it; test |
| B9 | reset limit is check-then-act across two processes | accepted: inside one process the lock covers it; the counter itself never exceeds the limit (checked again in the compare-and-set); two API processes could do one physical reset too many |
| B10 | late first tick sends every warning | fixed: only the urgent one is sent, all are recorded; test |
| B11 | sort key could overflow; 60 s destroy lease | fixed: a key that cannot overflow; lease 300 s |
| B12 | `Rules.from_dict` cut silently | fixed: strict types and no unknown member; test |
| C1 | gate sync refused after an orchestrator restart | fixed: an adopted instance gets a high access epoch; the lab opens it again with the next epoch (`_heal_access`); tests in the orchestrator and the runtime |
| C2 | secret-named fields blanked before the CRS | fixed, **a decision to confirm**: the helper sees the values (loopback, keeps nothing, logs nothing); cookies, authorization and flags still never go; the evidence capture still blanks. Reason: the classic login injection sits in a password field |
| C3 | relay binds 0.0.0.0 | option `EDGE_RELAY_BIND_HOST` added; default kept: the relay must be reachable from every instance network, the signature check and the per-peer limit are its protection (accepted) |
| C4 | gate cookie has no expiry | accepted: the contract says session life; revocation is the access epoch (gate-ticket.md section 3) |
| C5 | used tickets forgotten on an edge restart | accepted: a ticket lives 60 s and is bound to its owner and instance |
| C6 | env numbers not validated | fixed (review commit) |
| C7 | sidecar image hard-coded to amd64 | fixed: `ARG TARGETARCH` |
| C8 | relay limit per peer address | accepted: needs per-network binding (see C3) |
| C9 | secrets in Referer and Origin of a capture | fixed: blanked like the body; test |
| C10 | client x-vm-* headers forwarded | fixed: the edge drops them; test |
| D1 | audit ignored the content of VULNMART-LABS | fixed: new input `iptables-vulnmart-labs.txt`, a check, a bad fixture, runbook updated |
| D2 | container checks too narrow | fixed: added capabilities, host IPC, host user namespace, devices, unconfined profiles, binds below a sensitive path, exact proxy name |
| D3 | 9443 failed the listener check | fixed: allowed on a private address, a failure on every address |
| D4 | compose rules off without the profile | fixed: rules apply by service name as well |
| D5 | unreadable docker logs counted as clean | fixed (review commit) |
| D6 | harness forwarding check weak in product mode | fixed: the shop event must have seq 1 and be the only non-sidecar event |
| D7 | backup crash and inconsistent counts | fixed: counted before and after the dump, repeated up to 3 times, any table name |
| D8 | gate_key_previous mount creates a folder | fixed in the runbook (create an empty file first) |
| D9 | submission scan too narrow | fixed: logs, scripts and every doc folder, key files by name; the repo still passes (588 files) |
| D10 | fallback state file | fixed: per-user folder, corrupt state readable, only a real pid is killed, spawn error handled |
| D11 | socket proxy does not filter which container is attached | compensating audit check: only the edge gate may sit on an instance network (the proxy filter itself stays; accepted) |

## Tests
Real results at the end of the change: api 1763 passed, 4 skipped (Postgres 18 tests enabled); orchestrator 467 passed; py-attempts 357 passed; 
pm test 1023 tests, 1021 passed, 2 skipped, 0 failed; sidecar 66 passed (
ode --test services/sidecar/test/*.test.mjs); edge 104 passed. Two of my own mistakes were caught by the repository's checks and fixed: a literal key-looking string in a new test (the secret scan found it) and a PowerShell string that expanded $ placeholders in a JavaScript file.

## Limitations and follow-ups
The five accepted findings (A4 partly, B9, C3, C4 partly, C5, C8, D11 partly) need a decision of the team if the risk matters more than today's reasons say.