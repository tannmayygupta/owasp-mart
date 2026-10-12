# 0028. IF-5: problem details, state report transition number, strict integers

- **Status:** Accepted (D-47, on the developer's delegation 2026-10-11; revisable); the platform side is still to be confirmed by Akshay (H-106)
- **Date:** 2026-10-11
- **Deciders:** Tanmay (by delegation to Claude Code, story 1.15)
- **Requirements:** NFR-SEC-03, NFR-SEC-04, FR-INS-07, D-39 (M1 of ADR 0019), D-42, handoff H-91; contract IF-5 version 0.3.0

## Context
Review of pull request 3 found three weaknesses in the orchestrator API (IF-5):
1. A state report had no number. Two changes in the same second share `at`, a retried report cannot be told from a new one, and a real re-entrant change (`active` to `idle` twice) looks like a duplicate.
2. Integers were only "integers" to a JSON Schema validator, which also accepts `1.0`. Node reads `1.0` and `1` as the same number, Python keeps them apart, so one body could mean two things (and a signing string built from a number would differ by language). The two hosts also disagreed on booleans, on garbage list cursors, and on the order of the 415 and 404 checks.
3. The error body was "problem-details style" with a closed schema and a `message` member. ADR 0019 (M1) already decided to adopt RFC 9457; this is that change for IF-5.

## Options considered
1. **Keep the closed `Problem` schema** (add the standard members but keep `additionalProperties: false`). Simple to validate, but every new member is a breaking change, and RFC 9457 tells clients to ignore unknown extension members. Rejected.
2. **Keep floats accepted** (document that `1.0` means 1). Needs no code, but the fingerprint (`2.0` vs `2`), the signature input and the dedup identity then depend on the language of the reader. Rejected.
3. **Chosen:** open `Problem` with the RFC 9457 members; required `transition` on `StateReport`; integer tokens only, within 2^53 - 1; one order of checks.

## Decision
- **Problem details.** `application/problem+json`; standard members `type` (`https://vulnmart.invalid/problems/<lower-case code>`, a placeholder host never contacted), `title` (fixed per code), `status`, `detail`, `instance` (`urn:vulnmart:request:<request_id>`); extension members `code`, `request_id`, `field`. `message` is removed. The schema is open; `message`, `stack`, `trace` are refused so that no stack trace can slip in (NFR-SEC-03). The Python client picks its exception from `code`, uses `detail` as the message, ignores unknown members, and treats an error answer that is not `application/problem+json` as unavailable.
- **`transition`.** Required integer from 1, assigned by the orchestrator per `(instance_id, epoch)`; a reset starts again at 1. Identity of a report is `(instance_id, epoch, transition)`. Platform: new 204, identical repeat 200, other body 409 `ORCH-REQUEST-MISMATCH`, lower number stored as history and the current state never moves back; a higher epoch wins over a higher transition of an older epoch. `at` orders nothing. Implemented as `StateReport` and `ReportIngest` in `apps/api/src/vulnmart/ports/instance_host.py`.
- **Strict integers.** Every integer is `type: integer`, `format: int64`, with a minimum and a maximum of at most 2^53 - 1. A receiver refuses `1.0`, `1e0`, booleans, `NaN` and larger numbers with 422 `ORCH-VALIDATION`. A schema validator cannot see this, so the fake orchestrator reads numbers with its own small JSON reader, the Python hosts test `type(x) is int`, and the check script reads examples with a validator whose `integer` is a real `int`. `limits.cpu_limit` is the one non-integer and is compared by value (`2` equals `2.0`) in both hosts.
- **Order of checks.** Signature, call exists, media type (415, new `ORCH-UNSUPPORTED-MEDIA-TYPE`), shape (422), template, existence (404), state (409), capacity (429). The fake used to look the instance up before reading the body; the contract text says shape comes first, so the fake was changed, not the text. A list cursor is the base64url of an instance id; anything else is 422 `ORCH-CURSOR-INVALID`.
- **Client TLS.** `HttpInstanceHost` refuses an https `ssl_context` whose `verify_mode` is not `CERT_REQUIRED` or whose `check_hostname` is off; plain http stays loopback only.

## Consequences
- Breaking before v1.0.0, declared in `contracts/CHANGELOG.md` (IF-5 0.3.0). Akshay's platform ingest must send/accept `transition`, the new answers and the new error body (handoffs H-91 and a new one for the report dedup).
- Easier: members can be added to `Problem` later without a breaking change; reports can be replayed and reordered safely.
- Harder: every language must read numbers token by token; Node's `JSON.parse` is not enough for a receiver.
- Watch: the `type` base address is a placeholder until the error registry (IF-8). The IF-2 side of the same change is a separate part of story 1.15.

## Evidence
- RFC 9457, Problem Details for HTTP APIs, https://www.rfc-editor.org/rfc/rfc9457 (members, extension members, "ignore unknown extensions"). **Cited from knowledge and from the earlier research in ADR 0019; not re-read in this task.**
- RFC 8259, JSON (number grammar, section 6, which allows `1.0`, `1e0` and leaves precision to the implementation), https://www.rfc-editor.org/rfc/rfc8259. **Cited from knowledge; not re-read.**
- RFC 7493, I-JSON, https://www.rfc-editor.org/rfc/rfc7493: section 2.2 was fetched on 2026-10-11 with a summarising fetch tool; it says a receiver cannot be expected to treat an integer above 9007199254740991 in absolute value as exact, which is the origin of the 2^53 - 1 limit.
- Verified by running: `apps/api/tests/test_wire_rules.py`, `test_reports.py`, `test_http_service.py`, `test_contract.py`, `scripts/e2e/orchestrator.e2e.test.mjs` (results in the dev-log of story 1.15).
