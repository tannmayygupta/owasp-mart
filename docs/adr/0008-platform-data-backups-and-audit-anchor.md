# 0008. Platform data placement, backups, keystore and audit anchor (OI-28)

- **Status:** Placement accepted by the user (D-28); keystore rule and anchor are Proposed
- **Date:** 2026-10-08
- **Deciders:** the user (D-28) for placement; pending for the rest
- **Requirements:** FR-PRV-10, FR-PRV-12, NFR-AVL-05; OI-28

## Context
Where PostgreSQL and Valkey run, where 14-day backups and the audit-chain anchor live, and how crypto-shredding survives backups.

## Options considered
1. Self-host Postgres and Valkey on the platform VM, encrypted backups to Oracle Object Storage (D-28).
2. Neon plus Upstash free tiers: idle suspend, command quota, third-party region.
3. Managed Postgres with self-hosted Valkey.

## Decision
Option 1 (D-28). Proposed refinements: nightly dump of `vulnmart`, 14-day lifecycle; the wrapped per-attempt keys live in a separate `vm_keystore` database whose snapshot is kept latest-only (shred = delete key, new snapshot, delete older snapshots), so old data backups cannot be decrypted; anchor of the audit-chain head by a signed daily commit to a separate private repo plus an email to admins; backup key pair with the private half offline.

## Consequences
We operate backup and restore (monthly drill). A damaged keystore makes data unreadable, so keep two latest copies and an offline KEK copy. Object Storage limits (20 GB, 50,000 requests per month) bound dump size.

## Evidence
https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (VERIFIED); RS-A, RS-H. Restore proof: spike S-10 and S-19. See docs/architecture/04-data-and-state.md.
