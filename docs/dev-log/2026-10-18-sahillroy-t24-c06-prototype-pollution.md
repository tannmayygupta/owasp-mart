# T-24 C06 Vulnerable Components (prototype pollution in the import service)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-challenges-c05-c08 story 6.2 |

## Requirements covered
FR-CHL-07 (C06). Challenge spec C06. Spike S-9.

## Summary (plain language, 3-5 lines)
Built C06: the import service's product-preview merge. The fixed (default) build uses the safe merge that drops `__proto__`/`constructor`/`prototype`; the vulnerable build uses a naive recursive merge, so an import patch carrying `__proto__` pollutes the worker's `Object.prototype`. Because the import service forks a fresh process per job with no network and no database, the pollution is confined to a process about to exit — no code execution. The worker's own `proto_check` reports `polluted` on the vulnerable build and `clean` on the fixed build.

## Why
FR-CHL-07 / C06 (vulnerable/outdated components, prototype pollution). The import worker (T-12) was built with the safe merge and a note that the vulnerable merge is the C06 challenge; this adds it, gated.

## What was built
- `unsafeMerge` in the import worker (a naive recursive merge, no dangerous-key filter), selected only when `VM_CHALLENGE_C06=vulnerable` (or `VM_CHALLENGE_MODE=vulnerable`); `safeMerge` remains the default.
- A self-test driving `runJob` in both modes (the import service is a socket/worker service, not HTTP, so this does not use the HTTP exploit runner).

## How it works
`preview(job)` picks `unsafeMerge` when the C06 flag is set, else `safeMerge`. A patch `{"__proto__":{"polluted":true}}` (an own key, as the socket server's `JSON.parse` produces) recurses into `out["__proto__"]` in the unsafe merge, setting a property on the prototype. The forked worker computes `proto_check` and returns it; the pollution dies with the worker.

## Files changed
- `services/import-service/src/worker.mjs` — `unsafeMerge` + `isC06Vulnerable`; `preview` selects the merge.
- `challenges/tests/c06-prototype-pollution/c06.test.mjs` — new.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 22 pass (C06 3/3: polluted on vulnerable, clean on fixed, parent process untouched). `node --test services/import-service/test/*.test.mjs` — 5 pass, 2 Windows-skip. The import-service isolation harness (T-12) still proves no network/db.

## Security notes (vulnerable parts only)
The vulnerable merge prototype-pollutes (CWE-1321), gated by `VM_CHALLENGE_C06` and off by default. It is contained in a fresh per-job worker process with no network and no database, so the only effect is pollution of a process that immediately exits — no code execution, nothing to exfiltrate. The fix is the safe merge (dangerous keys dropped, bounded depth), which is the default.
