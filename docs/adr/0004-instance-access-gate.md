# 0004. Instance access gate at the edge

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** FR-INS-10, FR-SES-04, FR-SES-11, NFR-ISO-04

## Context
Only the owner may reach an instance; a new login must invalidate the older browser session; a frozen instance must accept no player requests. The PRD gives no mechanism.

## Options considered
1. One-time signed ticket in a URL, exchanged for a host-only `__Host-` cookie, verified by a small gate service beside the edge.
2. mTLS client certificates: poor fit for browsers and candidates.
3. Unguessable hostname only: a leaked link gives access.
4. Proxy instance traffic through the platform API: heavy, puts hostile traffic in the API.

## Decision (proposed)
Option 1. Ticket lives about 60 seconds and is single use; the cookie carries instance, user and an access epoch; the orchestrator pushes access state (open, frozen, closed) and epoch to the gate; the edge strips the gate cookie before forwarding. The shop opens in a new tab.

## Consequences
Freeze closes the door at once. The gate key is shared by API and gate only. Adds one small service. Instance traffic is not broken by headers because the edge adds no CSP.

## Evidence
Design in docs/architecture/03-origins-and-access.md section 3. Caddy forward_auth and cookie handling not read this session (UNVERIFIED); SameSite and cookie-prefix behaviour from MDN-level knowledge, spike S-14 and S-15.
