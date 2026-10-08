# 0009. Key hierarchy and secret storage

- **Status:** Proposed; the **per-attempt data key** part is Accepted by the user (D-35, 2026-10-08). The rest (independent versioned keys, file secrets, flag digests in the sidecar) still awaits the user.
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** D-02, D-23, D-25; FR-FLG-02..04, FR-PRV-12, NFR-SEC-05

## Context
Flag master key, event keys, per-attempt data keys and platform secrets need owners and places.

## Options considered
1. Independent versioned keys per purpose, stored as root-only files mounted as container secrets.
2. One root key with derived subkeys: one loss or leak affects everything.
3. OCI Vault or another KMS: extra setup, free allowance exists.

## Decision (proposed)
Option 1. The platform worker computes flags and sends them to the orchestrator, which never holds the master key and injects them through standard input. Per-instance event keys are derived from a versioned master and the instance id. The sidecar gets SHA-256 digests of flags, not values, so flag values never travel in events or logs. One data key per attempt (not per assessment), wrapped by a versioned key-encryption key. Gate, origin and signing keys as listed in 06.

## Consequences
Orchestrator compromise leaks only flags of instances in flight. Rotation is per version. Losing the key-encryption key makes evidence unreadable, so an offline copy is needed.

## Evidence
RS-B section 7; docs/architecture/06-security.md section 3 and 04 section 11. Vercel origin-secret rotation pattern: https://vercel.com/docs/rewrites (VERIFIED). Oracle Vault allowance: Oracle Always Free page (VERIFIED). Docker secret handling and HKDF usage: general practice, UNVERIFIED.
