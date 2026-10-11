# IF-8 change request for streams L and T

Date: 2026-10-11. From: Akshay (stream P, owner of IF-8), story P-02. To: Tanmay (stream L), Sahil (stream T, event consumer).
Status: **proposed**. IF-8 0.1.0 is in pull request #6 (branch `sprint-1-akshay`); nothing in streams L or T was changed by it.

## What IF-8 now says

- One registry, `contracts/errors/error-codes.yaml`, with 48 codes. Every code your contracts name today is in it **under the same name**.
- One error body (RFC 9457 members `type`, `title`, `status` plus `code`, `request_id`, optional `field` and `errors`), schema `contracts/errors/problem.schema.json`. This is Tanmay's decision M1 (ADR 0019): the body moves to RFC 9457 members.
- Generated constants: `packages/py-models/src/vulnmart_models/error_codes.py` (`ErrorCode`, `ERRORS`) and `packages/ts-client/src/error-codes.ts`.

## What streams L and T change (in their own stories, not in P-02)

1. **Body shape.** Three shapes exist today:
   - IF-2 and IF-5 (`lab.openapi.yaml`, `orchestrator-api.md`): `code`, `message`, `request_id`, `field`. Change to `type`, `title`, `status`, `code`, `request_id`, optional `field`, optional `errors`. `message` becomes `title` (the registry's fixed text); the pattern of the `ErrorCode` schema becomes `^[A-Z]{2,6}(-[A-Z]+)+$` or a reference to the registry.
   - IF-4 (`contracts/events/app-events.md`, fake ingest): `type`, `title`, `status`, `code`, `message`, `request_id`, `errors` as `{ path, message }`. Drop `message`; `errors` entries become `{ pointer, detail }` (the pointer replaces `path`).
   - The `Problem` schema and the example error bodies of all three contracts, and the fake lab, fake orchestrator and fake ingest mocks. This is the story 1.12 of ADR 0019.
2. **Placeholder wording.** Remove "placeholder until IF-8" from `lab-api.md` section 5, `orchestrator-api.md` section 6, `app-events.md` (items 5 and 21 of its open points) and `instance-contract.md` (open point 5): the names are final in IF-8 0.1.0. Where a document lists "INST-*" as a family, point to the registry.
3. **Titles.** The registry holds the fixed generic text of each code; mocks and real services use it (through the generated constants) instead of their own message strings.
4. **Request IDs.** `request_id` is 8 to 64 letters, digits and hyphens, as in IF-2 today.

## Migration

Contracts are `0.x` until `contracts-v1.0.0`, so this body change is allowed as a breaking minor bump (`contracts/CHANGELOG.md`); expand-then-contract applies from v1.0.0. There is no overlap period: each stream moves its contract, its mock and its tests in one story, and the platform dashboards read `code` and `request_id` only (nothing in `apps/web` reads `message` today). Suggested order: IF-5 and IF-2 together with Tanmay's story 1.12, IF-4 with the fake ingest, before the contract tag.

## Please check in review (my proposals)

- The **HTTP status** and **retryable** flag of each code, and the generic **title** texts.
- `status: null` for codes that never travel as an HTTP answer: `INST-HEALTH-TIMEOUT`, `INST-LOST`, `INST-INJECT-*`.
- `ORCH-UNAVAILABLE` (503): the orchestrator client's own "could not reach or understand the orchestrator". It is in the registry because `apps/api/tests/test_contract.py` on your branch counts it; say if the client should keep it private.
- Not seeded, on purpose: `INST-INJECT` (a prefix), `ORCH-ERROR` (base-class label in `ports/instance_host.py`), `ORCH-MYSTERY` (a test value for an unlisted code).
- The injector exit codes 10 to 13 are recorded as `exit_code` on the four `INST-INJECT-*` codes; "any other exit" is `INST-INJECT-FAILED` with no fixed number.

## Adding a code later

Add the entry in sorted order, run `node scripts/generate-error-codes.mjs`, commit the registry and the generated files together, and add a line to `contracts/CHANGELOG.md` (minor bump). Renames and status changes are breaking.
