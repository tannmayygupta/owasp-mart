# RS-C — Scoring model, "time taken", anti-cheat, assessment session design
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Covers R-05, R-10, R-11 from `initial.md`. Decisions D-01 to D-14 are not reopened. Sources marked VERIFIED were read as a page in this session. Several vendor pages could only be seen as search snippets, so they are marked UNVERIFIED. Nothing here was tested; formulas are proposals.

## 1. Questions answered
1. What scoring models do CTF and hiring platforms use, and what formula should VulnMart use for learner mode and hiring mode (section 3.1 to 3.3)?
2. How should "time taken per challenge" be defined and logged (section 3.4)?
3. Which anti-cheat measures fit hiring mode without breaking the minimal-data rule D-12 (section 3.5)?
4. How should an assessment session work: template, invite, states, expiry, reattempts (section 3.6)?

Key finding: all 11 challenges live in **one shop instance** per user. A candidate can attack several challenges at once. So "time per challenge" cannot be measured like a coding test with one question on screen. This shapes the recommendation.

## 2. Options compared

### 2.1 Scoring models seen in the wild
| Platform | Points | Difficulty weighting | Partial credit | Time bonus | Hint cost | Tie-break | Evidence |
|---|---|---|---|---|---|---|---|
| CTFd static | Fixed value per challenge | Admin picks the value | None by default | None | Hint unlock deducts points; cannot go below zero (a user needs at least the cost) | Not covered in docs read | CTFd hints page (VERIFIED) |
| CTFd dynamic | Value falls as more people solve: `value = ceil(((min - initial) / decay^2) * solves^2 + initial)`, never below the minimum | Initial/minimum set by admin; "difficulty" is learned from solve count | None | None (earlier solvers keep the higher value) | Same as above | Not covered | CTFd dynamic page (VERIFIED) |
| GZCTF | Exponential decay `S*(r+(1-r)*exp((1-x)/d))`; first-blood multipliers 1.5x, 1.3x, 1.1x | Base score S | None | First-blood bonus | Not found | Total score, then time of last accepted submission (earlier wins), then team ID | GZCTF scoring mirror (UNVERIFIED: third-party mirror; its tables disagreed with its own formula) |
| Hack The Box (Seasons) | Fixed per flag by difficulty: user flag 20/30/40/50, root flag 25/35/45/55 (Easy to Insane); first blood +5/+5/+6/+7 | Yes, four tiers | One flag at a time | First-blood only | Not found | Not found | HTB seasons post (UNVERIFIED: snippet only, 2023) |
| TryHackMe | Points by room difficulty; challenge rooms pay more than walkthroughs; first blood earns more; points withheld when machine activity is below a baseline | Yes | Per question | First blood only | Not found | Leaderboard needs 100 points to rank; monthly reset | TryHackMe points page (VERIFIED) |
| PortSwigger | Labs graded Apprentice, Practitioner, Expert | Yes (levels) | None | None found | Hints and solution on demand, no points found | Points/leaderboard: **not found** | secondary articles (UNVERIFIED) |
| HackerRank / CodeSignal / Codility | Weighted test cases, composite score. CodeSignal gives a single validated "Coding Score" | Mixed easy/medium/hard sections | Yes, via test cases | None found. Time spent is **shown**, not rewarded | Not applicable | Not found | search snippets (UNVERIFIED) |
| HackerEarth, Immersive Labs | Auto-graded tasks; Immersive shows accuracy and lab completion time to recruiters | Same criteria for all candidates | Per task | Time shown to recruiter | Not found | Not found | Immersive Labs pages (UNVERIFIED: snippets) |

Takeaway: practice platforms reward speed only through first blood and decay. Hiring platforms mostly **score correctness and show time separately**. No hiring vendor documented hint costs (matches the D-08 caveat).

### 2.2 Definitions of "time taken"
| Option | Fit | Cost | Complexity | Main risks |
|---|---|---|---|---|
| A. Instance start to capture | Easy to log | Free | Low | Counts boot time, reading, breaks, other challenges |
| B. First request on that challenge to capture | Fair to the candidate | Needs attribution of requests to a challenge (the D-07 classifier gives a rough label) | Medium | Wrong attribution; recon is shared across challenges |
| C. Active time: sum of gaps shorter than an idle limit | Best measure of effort | Event log only | Medium | Idle limit is a judgment call; thinking time is not "idle" |
| D. Pause and resume by the candidate | Fair for long take-home style tests | Needs rules | Medium-high | Abuse: pause to research offline; breaks comparability |

### 2.3 Anti-cheat measures
| Measure | Value | Privacy cost (D-12) | Complexity | Notes |
|---|---|---|---|---|
| Unique flags per instance (D-02) | High | None | Done | Baseline |
| Decoy flags | Medium | None | Low | Fake flags that cannot be earned legitimately; submitting one is a strong share/guess signal. GZCTF/rCTF use per-team flags and submission logging (from D-01 evidence) |
| Submission rate limit and attempt cap | Medium | None | Low | Stops guessing and brute force of the paste box |
| Activity-versus-capture check | High | None (data already in the instance) | Medium | TryHackMe compares activity with a baseline and withholds points (VERIFIED) |
| Timing anomalies | Medium | None | Low | Capture implausibly soon after start; HackerRank uses "time on question" vs averages (VERIFIED) |
| Write-up similarity | Medium | Low | Medium | HackerRank flags code similarity at 75% or more (10+ lines), 90% below that (VERIFIED). Our write-ups are short, so use as a hint for a human only |
| Single-use, expiring invite; session binding | High | Low | Low | Codility and HackerRank expiry is opt-in (UNVERIFIED snippets); HTB uses Guest accounts with an expiration date (UNVERIFIED snippet) |
| Email-verified login (identity light) | Medium | Low | Low | Invite goes to one email; login via our account (D-05) |
| Tab-switch and paste tracking | Low here | Medium | Medium | Not meaningful: candidates must use external tools (Burp, browser) |
| Webcam / screen proctoring, ID check | High | **High**, conflicts with D-12 "no webcam or screen recording" | High | CodeSignal uses video, screen, audio and ID checks (UNVERIFIED snippet) |

### 2.4 Leaderboards in learner mode
| Option | Pros | Cons |
|---|---|---|
| Global public | Strong engagement for top users; familiar (TryHackMe, HTB) | Demotivates the bottom; invites cheating by copying write-ups; leaks real names |
| Private cohort / opt-in | Peer motivation, instructor view | Needs groups feature |
| None, personal progress only | Safe, simple | Less social pull |

Research on leaderboards is mixed: some work finds harm for low-ranked users, other work finds benefit or no clear effect (UNVERIFIED: search snippets, not read in full).

## 3. Recommendation

### 3.1 Principles
1. **Score correctness only; show time separately.** Time is not in the points in hiring mode. This keeps scores comparable and avoids punishing careful candidates. Recruiters see time as a second column.
2. **One formula shape, two profiles.** Same engine (O5), different settings.
3. **Fixed points per challenge, not dynamic decay.** Decay depends on how many others solved it, so two candidates tested on different days get different points. That breaks "comparable" for hiring. CTFd's own dynamic scoring needs a population (VERIFIED).

### 3.2 Hiring-mode formula
Each challenge `c` has a **weight** `W_c` by difficulty tier (proposal: Easy 60, Medium 90, Hard 120; tiers set during R-06 challenge design). Total of 11 challenges is normalized to 1000 for display.

Each challenge has **milestones** with fixed shares of `W_c` (proposal: M1 "found the weakness" 20%, M2 "working exploit evidence" 40%, M3 "flag captured" 100% cumulative). Milestones are detected automatically (monitor events, D-01, D-07), never self-declared.

```
raw_c   = W_c * (highest milestone share reached on any valid path)
net_c   = max(0, raw_c - hint_cost_c)          # D-08: never below zero, per challenge
score   = sum(net_c)  ;  shown_score = round(1000 * score / sum(W_c))
```
Rules:
- **Hint cost** is a recruiter setting per assessment: off (default), or a percentage of `W_c` per hint level (proposal: 10%, 20%, 30%). Cost is charged from that challenge only, so a hint cannot erase points from other challenges. Because milestones lower the base, a hint taken before any progress costs nothing yet visible; to stay fair, cost applies **when the challenge score is computed**, floored at 0.
- **Multiple exploit paths:** milestones are defined by outcome ("read another user's order", "got a token as admin"), not by technique. The best milestone reached on any path counts once. The technique (D-07) is recorded for the recruiter but does not change points. Optional later: a small bonus is deliberately **not** included, to keep scores simple.
- **Wrong or decoy submissions:** no point penalty. Logged and counted for integrity review only (a penalty lets one guess poison honest results and complicates the floor rule).
- **Tie-breaks (in order):** higher number of fully captured challenges; lower total hint cost; lower active time (see 3.4); earlier last capture. These are shown as a ranking aid only; recruiters decide.

Worked examples (Easy 60, Medium 90, Hard 120; hints on, 10/20/30%):
| Case | Calculation | Result |
|---|---|---|
| Full capture of a Medium, no hints | 90 * 100% | 90 |
| Medium: exploit evidence but no flag | 90 * 40% | 36 |
| Hard: flag captured, two hints used (10% + 20%) | 120 - 0.30*120 = 84 | 84 |
| Easy: only finding the weakness (20%), then 1 hint (10%) | 60*0.20 = 12, minus 6 | 6 |
| Easy: finding the weakness (20%), then 3 hints (60%) | 12 - 36, floored | 0 (not -24) |
| Candidate captures all 11 with no hints | sum(W_c) | 1000 shown |

Edge cases: a challenge reset (candidate wipes the instance) keeps milestones already earned (they are logged events), because flags are regenerated per instance and a repeat must be re-captured only if the recruiter chooses "reset loses progress" (decision candidate 6). Two paths reaching the same milestone score once. A flag pasted that the monitor never saw: credited only if the activity check passes, else held for review.

### 3.3 Learner-mode scoring
- **No hint penalty ever** (D-08). Points are **mastery progress**: the same milestones give XP, plus a one-time "no hints" badge per challenge.
- Show per challenge: stars for milestones, a "solved" tick, and both OWASP tags (D-06). Show personal progress and the post-solve write-up (D-08).
- **Leaderboard:** recommend **no global public leaderboard** at launch. Offer an optional private cohort board that an instructor creates (the 5 authors can use it for the pilot). Reason: copied write-ups and shared flags matter less because per-instance flags exist (D-02), but the demotivation risk and public display of identity do not go away. Flip this if the college wants a competition event.
- Fixed points, no decay, so a learner's progress does not change when others solve.

### 3.4 "Time taken" definition
Recommend **two measures, both from the event log**, plus the hard assessment clock:
1. **Time to capture (wall clock):** from the moment the instance became *ready for that candidate* (not requested) to the captured-flag event for that challenge. Simple and comparable between candidates because everyone starts from the same moment. Shown as the headline "time to capture".
2. **Active time (effort):** total of gaps between that candidate's requests and platform events that are shorter than an idle limit (proposal 5 minutes; counted as 0 beyond the limit). Reported at **assessment level** and, as an estimate, per challenge using the D-07 classifier to label requests. Label per-challenge active time "estimated".
3. **Idle:** never subtracted from wall clock; excluded from active time.
4. **Retries and resets:** all attempts are kept as separate events; time to capture runs on from the first start, not reset by a retry.
5. **Concurrent challenges:** wall-clock time is the same clock for all; this is why per-challenge wall time looks like "time into the assessment" and is not "time spent on this challenge". Say so on the dashboard.
6. **Pause:** hiring mode default = **no pause** once started (timer keeps running), like Codility, which does not allow pausing after start (UNVERIFIED snippet). Learner mode needs no timer. Optional recruiter setting "allow one pause" is a decision candidate.

Events that must be logged (all with UTC timestamp, attempt ID, instance ID, never raw personal data beyond IDs):
`invite_created, invite_opened, consent_given, session_started, instance_requested, instance_ready, request_seen (summary: method, path, status, classifier tag, challenge label), milestone_reached, flag_auto_detected, flag_submitted (result: correct / wrong / decoy; no value stored), hint_unlocked (level, cost), instance_reset, session_paused, session_resumed, time_warning_sent, session_expired, session_submitted, instance_destroyed, recruiter_viewed_report`.
Request bodies of captured evidence follow D-07; all other request bodies are not stored to respect D-12 minimum data (open question in RS-H).

### 3.5 Proportionate anti-cheat set for hiring
Adopt, in this order of value:
1. Per-instance flags (D-02) plus **decoy flags** in places only an attacker with the wrong approach would find. Decoy submission is shown to the recruiter as an integrity flag, never an automatic fail.
2. **Submission limits:** 5 wrong submissions per challenge per 10 minutes (then 10 minute lock); hard cap of 30 per challenge per assessment (proposal numbers, to be tuned).
3. **Activity-versus-capture check:** a capture is "consistent" if the instance log shows the expected pre-steps (for example at least the requests an exploit of that class needs). Inconsistent captures are **held for review**, not zeroed, because TryHackMe-style baselines come from a large population we do not have (spike).
4. **Timing anomalies:** flag if a capture comes before a minimum plausible time (set from pilot data), or after long idle then instant capture.
5. **Invite security:** single-use token, 128-bit random, stored hashed, bound to one email, expiry set by the recruiter (default 7 days, range 1 to 30), cancel and re-invite by recruiter. The candidate must log in with a verified account (D-05). Session is bound to one active browser session (new login invalidates the old); the instance URL is bound to the account.
6. **Write-up similarity:** compare optional write-ups across the same assessment only, flag for human review.
7. **Not recommended:** webcam, screen recording, ID photo (conflict with D-12, high privacy cost, and legal burden). Offer instead an optional **recruiter follow-up interview** ("walk me through your exploit"), which is how the evidence (D-07) is best used. Tab-switch tracking is not useful because candidates must use external tools.
8. Integrity signals are **evidence for a human**, as HackerRank states about its own flags (UNVERIFIED snippet). The platform never auto-rejects.

### 3.6 Assessment session design
**Assessment template** (recruiter-configurable): title; challenge set (any of the 11); order (fixed or free; recommend free, since the shop is one instance); time limit (default 120 minutes, range 30 to 480); hints (off / on with cost %); pause allowed (off); instance reset allowed (on, limit 3); wrong-submission limits; invite expiry; retention period (default per Q-19); report visibility to candidate (after submit); write-up required or optional (D-07 open).

**Invite lifecycle:**
```
 created --> sent --> opened --> consented --> started
    |          |        |
    |          +--(expiry)--> expired
    +--(recruiter cancels)--> cancelled
```

**Candidate attempt states:**
```
 invited --open--> consent --accept--> ready --start--> RUNNING --submit--> SUBMITTED
                      |                                   |  ^                 |
                    decline                         pause |  | resume          v
                      v                             (if allowed)           REPORTED
                   WITHDRAWN                              v  |                 |
                                                       PAUSED                  v
                                       RUNNING --time limit hit--> EXPIRED --> (auto-submit) SUBMITTED
                                       RUNNING/READY --recruiter cancels--> CANCELLED
                          any state --retention date--> DELETED
```
**Time-limit enforcement:** the server clock is the only clock; the deadline is stored at start (`deadline = started_at + limit + paused_total`). The browser timer is cosmetic. Warnings at 15 and 5 minutes. Late requests are rejected after the deadline with a grace of 60 seconds for in-flight submissions.

**What happens to the instance at expiry:** state becomes EXPIRED; the attempt is auto-submitted with everything captured so far; the monitor does a final flush of milestones; the instance is **frozen** (network closed to the candidate) for a short grace of 15 minutes so the recruiter-side evidence can finish writing, then **destroyed**. Evidence (D-07) is kept per retention; the instance is never kept.

**Inactivity (F6):** separate from the time limit. In hiring mode an idle instance may be stopped and restored from its saved state, without stopping the assessment clock (spike: restore speed and state saving, RS-B).

**Reattempts:** default **one attempt**. Recruiter may grant a **re-invite** (new attempt, new instance, new flags, old attempt kept and marked "superseded", unlike HackerRank, whose re-invite deletes the previous report, UNVERIFIED snippet) for real faults such as outage. Candidates never reattempt on their own. Learners can reset any challenge any time.

**Recruiter-configurable settings** above; **not** configurable: per-instance flags, evidence capture, audit log, consent screen (D-12).

### 3.7 This would be wrong if
- The assessment needs a legally strong identity check (for example regulated hiring or exam credit): then proctoring is needed and D-12 must be revisited.
- Recruiters want speed-weighted scores: then add a bonus, but only with fixed thresholds (not decay) so scores stay comparable.
- Free-text/long candidates need breaks (take-home style, days): then allow pause with a total cap and treat active time as primary.
- The activity-versus-capture check proves noisy in the pilot: then drop it from "hold" to "flag only".

## 4. Decision candidates for the user
1. **Does time count toward the score in hiring mode?** (a) Never, shown only (recommended); (b) small fixed time bonus; (c) recruiter setting. Reason: keeps scores comparable.
2. **Which time measure is the headline?** (a) Wall-clock time to capture from instance ready, plus estimated active time as secondary (recommended); (b) active time only; (c) wall clock only. Reason: wall clock is unambiguous; active time shows effort.
3. **Pause in hiring mode?** (a) No pause (recommended); (b) one pause up to a cap; (c) recruiter setting. Reason: pause breaks comparability.
4. **Points per challenge: fixed or dynamic decay?** (a) Fixed with three difficulty tiers (recommended); (b) CTFd-style dynamic decay in learner mode only; (c) dynamic everywhere. Reason: decay needs a population and breaks comparability.
5. **Partial credit by milestones?** (a) Yes, 3 milestones 20/40/100% (recommended); (b) only full flag counts; (c) free number of milestones. Reason: shows how far a candidate got and our monitor can detect it.
6. **Does an instance reset lose earned milestones?** (a) No, milestones are kept (recommended); (b) yes, redo; (c) recruiter setting. Reason: avoids punishing a reset after a broken instance.
7. **Hint cost model when hints are on?** (a) Percentage of that challenge's points per level, floored at zero per challenge (recommended); (b) flat points; (c) hints cost time only. Reason: scales with difficulty and cannot hurt other challenges.
8. **Learner leaderboard?** (a) None at launch, private cohort board optional (recommended); (b) global public opt-in; (c) global public default. Reason: avoids demotivation and identity exposure.
9. **Wrong or decoy submissions?** (a) No point penalty, logged as integrity flag (recommended); (b) small penalty; (c) lock after N. Reason: penalties complicate the floor rule; the cap handles abuse.
10. **Anti-cheat set?** (a) Decoys + limits + activity check + timing + invites + similarity, no proctoring (recommended); (b) add optional webcam; (c) minimal: flags + limits only. Reason: proportionate and keeps D-12.
11. **Suspicious capture result?** (a) Hold for recruiter review, never auto-zero (recommended); (b) auto-zero; (c) log only. Reason: no population baseline yet; false positives would hurt honest people.
12. **Default time limit and invite expiry?** (a) 120 minutes, 7 days (recommended); (b) 60 minutes, 3 days; (c) set by recruiter with no default. Reason: 11 challenges in one app need time.
13. **At expiry: what happens?** (a) Auto-submit, 15 minute freeze, destroy (recommended); (b) destroy at once; (c) keep until recruiter closes. Reason: protects evidence and frees resources.
14. **Reattempt policy?** (a) One attempt; recruiter-granted re-invite, old attempt kept (recommended); (b) unlimited; (c) none ever. Reason: fair for outages, keeps an audit trail.

## 5. Evidence
| URL | What it supports | Status |
|---|---|---|
| https://docs.ctfd.io/docs/custom-challenges/dynamic-value/ | CTFd parabolic decay formula, parameters, minimum | VERIFIED |
| https://docs.ctfd.io/docs/challenges/hints | Hint cost deducts points, needs enough points, cannot go below zero; throwaway-account warning | VERIFIED |
| https://help.tryhackme.com/en/articles/6563910-points-explained | Points by difficulty, first blood, activity check withholding points, leaderboard rules | VERIFIED |
| https://hackerrank-knowledge-base.help.usepylon.com/articles/4291690360-plagiarism-best-practices-guide | Similarity thresholds, copy-paste, window exits, time on question, flags need manual review | VERIFIED |
| https://mintlify.wiki/GZTimeWalker/GZCTF/concepts/scoring | GZCTF formula, first-blood multipliers, tie-break order | UNVERIFIED (third-party mirror; example tables inconsistent with formula) |
| https://www.hackthebox.com/blog/htb-seasons-announcement | HTB per-difficulty flag points and first-blood bonus | UNVERIFIED (search snippet, 2023) |
| https://help.hackthebox.com/en/articles/5185158-introduction-to-htb-labs | HTB points by complexity, first blood | UNVERIFIED (snippet) |
| https://help.hackthebox.com/en/articles/12928718-candidate-assessment-management | HTB Guest access with expiration date; help options off, Mask Mode (direct fetch gave 404, seen in search snippet only) | UNVERIFIED |
| https://support.codility.com/hc/en-us/articles/1500008658641-Can-I-set-my-candidate-test-links-to-expire | Codility opt-in link expiry 1 to 90 days; no pause after start; auto-submit at time end | UNVERIFIED (snippet) |
| https://hackerrank-knowledge-base.help.usepylon.com/articles/6027855406 and /1002936098 | HackerRank invite expiry opt-in; re-invite deletes previous report | UNVERIFIED (snippet) |
| https://discover.codesignal.com/rs/659-AFH-023/images/CodeSignals-Cheating-and-Plagiarism-Approach.pdf | CodeSignal proctoring, ID check, leak sweep | UNVERIFIED (snippet) |
| https://support.immersivelabs.com/hc/en-us/articles/16514355742737-Candidate-Screening-An-Introduction | Immersive Labs shows accuracy and completion time; auto-detection of task completion | UNVERIFIED (snippet) |
| PortSwigger points/leaderboard | Not found | Not found |
| HackerEarth, Codility scoring formulas, any hiring-platform time bonus | Not found | Not found |
| Leaderboard studies (espol.edu.ec engineering education study; universityxp.com summary) | Mixed evidence on leaderboard motivation | UNVERIFIED (snippets) |

## 6. Open questions and spikes to run later
- **Spike:** do the milestone events of each challenge fire reliably in the monitor (RS-B, RS-E, RS-F define them per challenge)? The 20/40/100 split needs a defined M1 and M2 for each of the 11.
- **Spike:** measure real solve times in the pilot (Q-22) to set the minimum plausible time, the idle limit, and the default time limit.
- **Spike:** is the D-07 classifier accurate enough to attribute requests to challenges for per-challenge active time? If not, report active time at assessment level only.
- **Spike:** can an instance be stopped and restored with state during a running assessment (RS-B)?
- Does the solution write-up appear in hiring mode (open in D-08)? Recommend hidden until recruiter closes.
- Retention of timing and request-summary events vs D-12 minimum data: RS-H.
- Difficulty tier per challenge (R-06). The weights 60/90/120 are placeholders.
- How candidates are identified to the recruiter if a pasted flag matches no activity (human review process and who is accountable).
- Is Hack The Box and PortSwigger scoring detail important enough to re-check directly in their apps (not found in docs)?

## 7. Impact on other streams
- **RS-B (isolation, flags, monitor):** must emit the milestone events and `request_seen` summaries above; needs freeze/destroy at expiry; decoy flags need generation per instance.
- **RS-D (platform, API, lifecycles):** attempt and invite state machines (3.6), server-side deadline clock, token hashing, submission rate limits, event log schema.
- **RS-E / RS-F (challenges):** each challenge must define two measurable milestones (M1, M2) besides the flag, a difficulty tier, and where its decoy flag sits.
- **RS-H (privacy):** the event list and integrity flags are processing of candidate data; retention, consent text (timing, hints, decoy logging) and audit view of integrity flags need to match D-12.
- **RS-A (hosting):** a 120 minute assessment holds an instance for its whole length plus 15 minute freeze; affects capacity numbers.
