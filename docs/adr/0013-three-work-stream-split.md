# 0013. Three work-stream split

- **Status:** Accepted by the user (D-33, 2026-10-08): split by contract boundary into P, L and T; assignment Tanmay L, Akshay P, Sahil T. Industry evidence added in `initial.md` D-33.
- **Date:** 2026-10-08
- **Deciders:** (pending the user; who takes which stream is the user's choice)
- **Requirements:** NFR-MNT-02, D-13; all FR groups

## Context
Three developers (Windows, Windows, Intel Mac) build everything with Claude Code and must not block each other.

## Options considered
A. By layer (frontend, backend, lab): busiest interface between two people building the same features.
B. By vertical slice (learn, hire, admin): shared kernel and instances have no owner; high conflict.
C. By trust zone (control plane, instance plane, target): clean contracts, but the control plane has about 109 of 170 requirement ids.
D. By contract boundary: P platform and dashboards (about 76 ids), L lab (instance lifecycle, attempt runtime, flags, events, scoring, deployment; about 62), T target and challenges (about 32, heaviest per id).

## Decision (proposed)
D. P and T have no direct interface; L is the hub and ships mocks, stubs and a lab harness in sprint zero. Suggestion only: Tanmay to L, Akshay to P, Sahil to T; the sidecar and Coraza spikes can move from L to T to rebalance.

## Consequences
Medium-low deadlock risk if the ten rules in 07 are followed. L must answer contract requests within about a day.

## Evidence
Requirement counts from docs/prd/PRD.md; comparison in docs/architecture/07-repo-and-workstreams.md section 7. No external source.
