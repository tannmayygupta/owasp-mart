# 0014. Organization scoping: application filter plus Row-Level Security

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** FR-ORG-06, NFR-EXT-01, NFR-SEC-08, FR-DSH-06

## Context
Every recruiter-owned row carries an organization id, filtered in one central place; a missing filter must fail a test.

## Options considered
1. Application filter only.
2. PostgreSQL Row-Level Security only.
3. Both.
4. Schema or database per tenant (SaaS later): heavy now.

## Decision (proposed)
Option 3. One session class adds the filter and raises an error when a scoped table is queried without scope; RLS policies compare the organization id to a per-transaction setting. The app connects as a role that is not the table owner and lacks BYPASSRLS, with FORCE ROW LEVEL SECURITY. Participant rows use a user-id scope.

## Consequences
Two layers catch each other's mistakes; RLS needs a transaction-scoped setting and tests for pooled connections. A tenant-per-schema move stays possible later.

## Evidence
https://www.postgresql.org/docs/18/ddl-rowsecurity.html (VERIFIED: owners and BYPASSRLS bypass, FORCE, default deny; session-variable pattern is general practice).
