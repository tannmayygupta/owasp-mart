---
title: 'C06 Vulnerable Components (prototype pollution in the import service)'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'built'
baseline_revision: 'dd39250'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C06 (OWASP 2021 A06 / 2025 A03, CWE-1321) needs a vulnerable-component-style flaw: a naive deep merge in the product-import preview that prototype-pollutes when a patch carries `__proto__`.

**Approach:** The import worker (T-12) already ships the safe merge (drops `__proto__`/`constructor`/`prototype`, bounded depth). C06 adds the deliberately vulnerable `unsafeMerge` (a naive recursive merge, no key filter) selected only when `VM_CHALLENGE_C06=vulnerable`. Because the import service forks a fresh process per job with no network and no database, the pollution is confined to a process about to exit — no code execution and nothing to exfiltrate.

## Boundaries & Constraints

**Always:** Default to the safe merge. Keep the vulnerable merge in the worker, gated by the env flag. The worker keeps its no-network/no-db isolation (T-12).

**Never:** No network or database in the import service. No persistence of the pollution beyond the one job's process. No real flag (the signal is the worker's own `proto_check`).

## I/O & Edge-Case Matrix

| Build | Job | Result |
|-------|-----|--------|
| vulnerable | `{product:{__proto__:{polluted:true}}}` | `proto_check: 'polluted'` |
| fixed | same | `proto_check: 'clean'` (key dropped) |
| either | a normal product patch | correct preview |
| either | — | the pollution never escapes the forked worker |

</frozen-after-approval>

## Code Map

- `services/import-service/src/worker.mjs` — `unsafeMerge` (vulnerable) selected by `isC06Vulnerable()`; `safeMerge` stays the default.
- `challenges/tests/c06-prototype-pollution/c06.test.mjs` — drives `runJob` in both modes.

## Tasks & Acceptance

- [x] Vulnerable merge (gated) + self-test.

**Acceptance:** a `__proto__` patch pollutes the worker prototype on the vulnerable build and is dropped on the fixed build; the import service has no network or database; the pollution does not escape the worker process.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C06 3/3.
- `node --test services/import-service/test/*.test.mjs` — import service suite passes.
