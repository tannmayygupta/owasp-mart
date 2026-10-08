---
type: epic
title: "Everything on the dashboards is live"
parent: initiative-platform
covers: [FR-LIV-01, FR-LIV-02, FR-LIV-03, FR-LIV-04, FR-LIV-05, FR-LIV-06]
after: []
assignee: "Akshay Gupta"
risk: high
---

# Everything on the dashboards is live

## Description

Every dashboard change reaches the browser over Server-Sent Events with event IDs, replay, heartbeats, no proxy buffering, a snapshot endpoint and a polling fallback, through the same-origin path.

## Outcome

Users see progress and scores update in real time without refreshing, and a dropped connection loses nothing; the signal is the acceptance criteria of FR-LIV-01 to 06 and the target latency fixed by spike S-2.

## Requirements

Numbered source: docs/prd/PRD.md section 5.14 (FR-LIV-01 to FR-LIV-06) and D-17 rules.

## Done when

1. A milestone event from the lab fake appears on a connected dashboard without a refresh, within the latency target set by spike S-2.
2. Killing the connection and one API worker loses no event (replay from Valkey Streams with Last-Event-ID).
3. A stream stays open through the real Vercel and Caddy path for longer than the smallest idle timeout, and a dashboard still updates by polling when streams are blocked.
4. A learner cannot subscribe to another user's events and a recruiter only to the company's attempts.

## Boundaries

The SSE hub, the replay buffer and the browser client. Not the events' content, which the lab publishes.

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.14
- decision, initial.md D-17
- architecture, docs/adr/0006-live-updates-sse-hub-valkey-streams.md

## Notes

- Unknown: whether SSE passes unbuffered through a Vercel external rewrite and for how long (spike S-14); fallback is the dashboards on the VM (D-28).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
