# 0004. Instance access gate at the edge

- **Status:** Accepted for Option 1 on 2026-10-17 (D-60), decided by Claude Code on the developer's delegation; the developer has not yet confirmed it, so it may still change. Details of the build: ADR 0040.
- **Date:** 2026-10-08 (status updated 2026-10-17)
- **Deciders:** Tanmay (by delegation to Claude Code, 2026-10-17)
- **Requirements:** FR-INS-10, FR-SES-04, FR-SES-11, NFR-ISO-04

## Context
Only the owner may reach an instance; a new login must invalidate the older browser session; a frozen instance must accept no player requests. The PRD gives no mechanism.

## Options considered
1. One-time signed ticket in a URL, exchanged for a host-only `__Host-` cookie, verified by a small gate service beside the edge.
2. mTLS client certificates: poor fit for browsers and candidates.
3. Unguessable hostname only: a leaked link gives access.
4. Proxy instance traffic through the platform API: heavy, puts hostile traffic in the API.

## Decision
Option 1. Ticket lives about 60 seconds and is single use; the cookie carries instance, user and an access epoch; the orchestrator pushes access state (open, frozen, closed) and epoch to the gate; the edge strips the gate cookie before forwarding. The shop opens in a new tab.

Update 2026-10-17 (D-60, delegated): Option 1 is built as the gate core in `apps/edge/` with the contract `contracts/edge/gate-ticket.md`, with these refinements: the gate fails closed (an unknown instance behaves as closed), the used-ticket set lives in memory (a gate restart loses it and the state, so everything is closed until the orchestrator syncs; a replay inside the 60 s window after a restart is the accepted residual), the cookie carries an owner hash (derived by the platform) and never an account id, and two keys (current and previous) are accepted for rotation. Built and tested locally only; not live. The developer still has to confirm.

## Consequences
Freeze closes the door at once. The gate key is shared by API and gate only. Adds one small service. Instance traffic is not broken by headers because the edge adds no CSP.

## Evidence
Design in docs/architecture/03-origins-and-access.md section 3. Caddy forward_auth and cookie handling not read this session (UNVERIFIED); SameSite and cookie-prefix behaviour from MDN-level knowledge, spike S-14 and S-15.

Update 2026-10-17 (edge stories 3 and 5, D-63, D-65; Proposed, delegated, not yet confirmed by the developer): the access epoch is the only session-binding mechanism at the gate. The platform raises it on every `open` and every login of the account, through IF-5 `access`; the orchestrator pushes the new state to the gate first and answers only after the gate took it (a gate failure fails the call, no ticket is issued); the gate refuses any cookie or ticket of an older epoch, so the earlier browser tab loses the instance at once. The gate never learns accounts or platform sessions (owner hash only); the platform's own session store invalidates the older platform session at login (handoff H-136). Local proof: `apps/edge/test/session-epoch.test.mjs` (second open, login bump, replay, freeze and thaw, close, key rotation, stale push). Live behaviour in a real browser is a runbook step (`docs/runbooks/edge-vm-i.md`).
