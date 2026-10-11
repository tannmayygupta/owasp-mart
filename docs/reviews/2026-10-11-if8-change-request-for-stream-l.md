# IF-8 change request for streams L and T

Date: 2026-10-11 (revised after merging `origin/main` with stream L's story 1.15). From: Akshay (stream P, owner of IF-8), story P-02. To: Tanmay (stream L), Sahil (stream T, event consumer).
Status: **proposed**. IF-8 0.1.0 is in pull request #6 (branch `sprint-1-akshay`). It changes nothing in streams L or T except small test adjustments listed at the end.

## What IF-8 says

- One registry, `contracts/errors/error-codes.yaml`, with 49 codes. Every code your contracts name is in it; only the spelling differs where listed below.
- One error body, schema `contracts/errors/problem.schema.json`, in RFC 9457 style (your decision M1, ADR 0019): `type`, `title`, `status`, `code`, `request_id`, optional `field` or `errors`. It is **closed** and does **not** use `detail` or `instance` (so a path or a submitted value cannot leak).
- Generated constants: `packages/py-models/src/vulnmart_models/error_codes.py` (`ErrorCode`, `ERRORS`) and `packages/ts-client/src/error-codes.ts`.

## How your merged contracts differ (after story 1.15)

IF-2 0.2.0, IF-5 0.3.0 and IF-4 0.2.0 each state that their error names stay placeholders until IF-8 ("IF-8 may rename the codes"). Today:

| | IF-2 (lab API) | IF-5 (orchestrator) | IF-4 (events) | **IF-8 0.1.0** |
|---|---|---|---|---|
| `code` | lower case, underscores (`auth_session_required`) | upper case, hyphens (`ORCH-STALE-EPOCH`) | upper case, hyphens | **upper case, hyphens** (`AUTH-SESSION-REQUIRED`) |
| `type` | `https://vulnmart.invalid/problems/<lower_code>` | `https://vulnmart.invalid/problems/<lower-code>` | (own) | `urn:vulnmart:error:<CODE>` |
| `title` | fixed sentence per code | fixed sentence per code | `title` and `message` | the registry's fixed sentence |
| `detail` | yes (this occurrence) | yes | `message` | **not used** |
| `instance` | `urn:vulnmart:request:<request_id>` | same | no | **not used** |
| schema | open | open | closed | **closed** |
| 422 details | `field` (one pointer) | `field` | `errors` as `{ path, message }` | `field` (one pointer) **or** `errors` as `{ pointer, detail }`, never both |

The code names map one to one (`att_not_found` is `ATT-NOT-FOUND`); 19 of the 20 lower-case codes in IF-2 were already in the seed and the twentieth, `att_gone`, was added as `ATT-GONE` (410).

## What streams L and T change (in their own stories, not in P-02)

1. **IF-2:** `ProblemCode` becomes the registry code (upper case, hyphens); `type` is the URN; drop `detail` and `instance`; close the `Problem` schema; update `lab-api.md` section 5, the examples and the fake lab. The failed-instance `ErrorCode` already uses the registry spelling.
2. **IF-5:** same shape change (drop `detail` and `instance`, URN `type`, closed schema); the codes already use the registry spelling. The `ORCH-*` codes stay out of browser answers.
3. **IF-4:** drop `message`; `errors` entries become `{ pointer, detail }`; the fake ingest follows.
4. **Wording:** remove "placeholder until IF-8" in `lab-api.md`, `orchestrator-api.md`, `app-events.md` and `instance-contract.md`; the names are final in IF-8 0.1.0.
5. **Mocks and services** take their `title` from the registry (through the generated constants) rather than their own strings; `detail` text, if you still want it for debugging, goes in logs, not in the answer.

If you prefer to keep `detail` and `instance` or an open schema, say so in review: those are the points where IF-8 chose the stricter option (no free text reaches a client) and I would change the contract rather than have two shapes.

## Migration

Contracts are `0.x` until `contracts-v1.0.0`, so this body change is allowed as a breaking minor bump (`contracts/CHANGELOG.md`); expand-then-contract applies from v1.0.0. There is no overlap period: each stream moves its contract, its mock and its tests in one story. The dashboards read `code` and `request_id` only (nothing in `apps/web` reads `message` or `detail` today). Suggested order: IF-5 and IF-2 together, IF-4 with the fake ingest, before the contract tag.

## Please check in review (my proposals)

- The **HTTP status** and **retryable** flag of each code, and the generic **title** texts.
- `status: null` for codes that never travel as an HTTP answer: `INST-HEALTH-TIMEOUT`, `INST-LOST`, `INST-INJECT-*`.
- `ORCH-UNAVAILABLE` (503): the orchestrator client's own "could not reach or understand the orchestrator". It is in the registry because `apps/api/tests/test_contract.py` counts it; say if the client should keep it private.
- Not seeded, on purpose: `INST-INJECT` (a prefix), `ORCH-ERROR` (base-class label in `ports/instance_host.py`), `ORCH-MYSTERY` (a test value for an unlisted code).
- The injector exit codes 10 to 13 are recorded as `exit_code` on the four `INST-INJECT-*` codes; "any other exit" is `INST-INJECT-FAILED` with no fixed number.

## Small changes this pull request makes in your files

- `apps/api/tests/test_contract.py`: the package-contents test now also allows the platform API modules `main.py` and `problem.py` next to `ports` (stream P shares the package).
- `scripts/oasdiff.test.mjs`: the severity file is read with `split(/\r?\n/)` so the test passes on a Windows checkout (`core.autocrlf=true`).
- `contracts/registry.json`: IF-8 is registered (`contracts/errors` was reserved); `scripts/ci-linux.mjs`: the new `errors-check` step.

## Adding a code later

Add the entry in sorted order, run `node scripts/generate-error-codes.mjs`, commit the registry and the generated files together, and add a line to `contracts/CHANGELOG.md` (minor bump). Renames and status changes are breaking.
