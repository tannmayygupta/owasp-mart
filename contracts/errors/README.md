# IF-8: error codes and error format

Version **0.1.0** (story P-02). Owner: stream P (Akshay). Anyone adds a code by pull request; the owner approves.
Consumers: every stream. Architecture: `docs/architecture/07-repo-and-workstreams.md` section 3.6. Requirement: NFR-SEC-03.

## What is here

| File | What it is |
|---|---|
| `error-codes.yaml` | The registry: every code with its HTTP status, generic title and retry hint. The one place a code is defined. |
| `error-codes.schema.json` | The shape of the registry file. |
| `problem.schema.json` | The shape of an error response body. |
| `examples/valid`, `examples/invalid` | Example bodies. Each invalid one is listed in `examples/invalid/manifest.json` with the path where it must fail. |

Generated from the registry (never edit by hand): `packages/py-models/src/vulnmart_models/error_codes.py` and `packages/ts-client/src/error-codes.ts`.

## The error body

Media type `application/problem+json`, in the style of RFC 9457. Members:

| Member | Required | Meaning |
|---|---|---|
| `type` | yes | `urn:vulnmart:error:` plus the code |
| `title` | yes | The registry's fixed, generic text for the code |
| `status` | yes | The HTTP status (400 to 599), equal to the registry's |
| `code` | yes | The registry code, for example `AUTH-SESSION-REQUIRED` |
| `request_id` | yes | 8 to 64 letters, digits and hyphens. Today the same ID is logged for unhandled errors; story 1.6 puts it on every request and log line (NFR-OBS-01) |
| `field` | no | 422 only. One JSON Pointer to the offending field (empty string for the whole body) |
| `errors` | no | 422 only. For several problems: up to 50 entries `{ "pointer", "detail" }`, `detail` a fixed generic text. `field` and `errors` are never both present |

The schema is closed: no other member is allowed. `detail` and `instance` of RFC 9457 are **not used**, so a path, a submitted value or an internal name cannot leak. Never a stack trace, never a submitted value, never a host, key or flag in any member.

```json
{
  "type": "urn:vulnmart:error:REQ-VALIDATION",
  "title": "The request is not valid.",
  "status": 422,
  "code": "REQ-VALIDATION",
  "request_id": "req-0a1b2c3d",
  "errors": [{ "pointer": "/quantity", "detail": "This value is not valid." }]
}
```

Every error answer also carries `Cache-Control: private, no-store` (architecture 03, section 1.3).

**Pointers.** A pointer is a JSON Pointer (RFC 6901: `~` is written `~0`, `/` is written `~1`). For a body field it points into the JSON body (`/items/0/quantity`); a body that is not JSON points at the whole body (`""`). For a query, path, header or cookie parameter the first segment names the location (`/query/limit`). Pointers are made of field or key names from the request, never of values; a pointer over 200 characters is answered as `""`.

**Raising a code.** In the platform API, route code raises `ProblemError(ErrorCode.ATT_NOT_FOUND)` (module `vulnmart.problem`). A plain `HTTPException` is for the framework: 404, 405, 413 and 415 map to `REQ-ROUTE-UNKNOWN`, `REQ-METHOD-NOT-ALLOWED`, `REQ-TOO-LARGE` and `REQ-UNSUPPORTED-MEDIA-TYPE`; any other framework status is answered as `REQ-INTERNAL` (500) and logged.

## The registry

Each entry: `code`, `status`, `title`, `retryable`, and for the injector `exit_code`.

- A code is `FAMILY-WORD[-WORD...]` in capitals. Families: `AUTH` (sign-in, session, origin), `ATT` (attempts), `EVT` (event ingest), `INST` (instances and the injector exit codes), `ORCH` (orchestrator, never reaches a browser), `REQ` (request-level errors any API can raise).
- `status` is the HTTP status when the code is sent as an HTTP answer, or `null` when it only appears inside an event or in `error_code` of a failed instance. A `null` code is never sent as an HTTP answer.
- `title` is a fixed text: no placeholder, nothing about the request or the server.
- Entries are sorted by code.

## Which code to use

Several families have a code for the same condition (for example `REQ-ROUTE-UNKNOWN` and `ORCH-ROUTE-UNKNOWN`). The rule: use the family of the **API that answers**. The platform API and the lab API (IF-1, IF-2) use `REQ-*` for request-level errors and `AUTH-*`, `ATT-*`, `INST-*` for their domains; the orchestrator (IF-5) uses `ORCH-*`; event ingest (IF-4) uses `EVT-*`. The pairs are kept because stream L's contracts already use them; a client matches on the code it was given and never maps one family to another.

## Changing it

- **Adding** a code is additive: a minor version bump (`contracts/CHANGELOG.md`). Add the entry in its sorted place, run `node scripts/generate-error-codes.mjs`, commit the registry and the two generated files together.
- **Renaming, removing or changing the status of** a code is breaking: it needs approval from every consumer and an expand-then-contract path (add the new code, keep the old for one release, remove it later).
- Application code names a code only through the generated constants, never as a string literal.

## Checks

`pnpm run errors:check` runs `node scripts/validate-errors.mjs` (registry rules, body schema, every example) and `node scripts/generate-error-codes.mjs --check` (the two generated files are current). CI runs both.

## Where the codes come from

The seed (48 codes) is every code named in the merged contracts and in stream L's in-flight branches (`sprint-1-tanmay`, `shared-L-03`) on 2026-10-11, under the names those contracts use, so none of them has to be renamed. Statuses and titles were proposed by stream P; stream L reviews them in the pull request. Not seeded: `INST-INJECT` (a prefix, not a code), `ORCH-ERROR` (a base-class label in the orchestrator client) and `ORCH-MYSTERY` (a test value for an unlisted code). See `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md` for what streams L and T change to match.
