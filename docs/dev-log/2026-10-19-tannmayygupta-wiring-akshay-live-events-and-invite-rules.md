# Wiring Akshay's merged work into the lab: live events, invite rules, and a score fix

Developer: tannmayygupta (stream L). Date: 2026-10-19. Branch: l-real-shop-injector (same pull request as the real shop).

## Requirements covered
FR-LIV-01, FR-LIV-02, FR-LIV-06 (publishing side), FR-ASM-01 (the attempt runs under its invite's rules), FR-SCR-03, PRD section 4 (learner hints are free); handoffs H-140, H-141, H-142; tasks L-21, L-23, L-26 (wiring), L-30 (wiring).

## Summary (plain language, 3-5 lines)
Akshay's sprint 3 and 4 work now in `main` was not connected to the lab. Three connections are made: the lab now publishes the domain events his live hub fans out to dashboards (instance and attempt changes, milestones, captures, score, hints); an attempt created from a consent runs under the time limit and reset limit of its invite; and the score no longer charges learners for hints (the PRD says learner hints are free; the screen already said so).

## Why
H-142 said it plainly: "Nothing in lab/ or ingest/ publishes yet". H-141 asked for the invite's rules to reach the attempt and for the accept flow to be checked on the Postgres lab. The audit had found the score charging learners for hints the UI shows as free.

## What was built
- `apps/api/src/vulnmart/lab/live.py` `LiveAnnouncer`: builds the six IF-3 events (ids, states, numbers, fixed words only), sends them best effort. `LabRuntime.live`, attached by `_mount_lab` to the platform's durable event port (`ports.outbox.publish`). Hooks: engine `attempt.state_changed`, credits of the milestone engine and its tick, a credited paste, a hint unlock, and the orchestrator's state reports (a new `on_moved` hook of the report route, `LabRuntime.announce_instance`). A held capture is not announced as a capture.
- `LabRuntime.score_rows` (moved from the API; the API delegates).
- `ports/engine_attempts.py` `attempt_rules`, and a `rules` parameter on `AttemptPort.create_from_consent` (protocol, engine port, fake): `time_limit_min` and `reset_limit` of the invite's rules become the engine's rules; strict.
- `RuntimeFacts` charges hint costs only for assessment attempts (an attempt with a company).

## How it works
Every change in the lab goes to the live hub as one durable row in `domain_events` (the relay resolves who may see it from the attempt row); a failing publisher is logged and never undoes the step.

## Files changed
apps/api/src/vulnmart/{lab/live,lab/runtime,lab/state_reports,lab/api,main,ports/engine_attempts,ports/attempts,ports/lab_fakes}.py and tests (test_lab_live, test_lab_runtime, test_lab_pg, test_lab_loop).

## Decisions made
Learner hints are free, assessment hints cost (PRD section 4 and FR-SCR-03). The platform's own priorities for superseding an attempt (H-141 point 2) stay with the `<template>~n` keys for now: they work, proved on Postgres; a real supersede waits for the routes.

## Tests
- test_lab_live (7): every event passes the platform's `check_event`, none carries a flag or text, order of events for a capture, a hint and the attempt states, a held capture is silent, instance states carry the attempt and access, candidate mode, a failing or missing publisher changes nothing.
- test_lab_runtime: invite rules reach the attempt (45 minutes, 1 reset; strict errors), hint cost only in assessments (learner 63, candidate 56); test_lab_pg: create_from_consent with an attempt id, rules and a re-invite key on a real Postgres, re-read by another runtime (25 passed in the file); test_lab_loop expectations moved from 147 to 156 (free hints).
- Related lab suites together: 137 passed before the last two additions, and test_lab_runtime, test_ports_lab, test_ports_platform 110 passed.

## Evidence
See the pull request and the deployed result below.

## Problems met and how they were fixed
`ports.outbox` is the live outbox of the platform (durable events) in a process with a database; in memory tests it is the fake, which validates the same way. The first score test expected the old learner score; updated deliberately.

## Limitations and follow-ups
The rest of an invite's rules (hints on or off, cost percent, the challenge list, the flag rate) is not applied yet: the engine's rules have no such members; this needs a decision with Akshay (H-351). The consent routes, the invite acceptance routes and the dashboards are Akshay's (P-22 routes, P-26, P-27); until they land the candidate flow cannot be run end to end.