---
title: 'Real sidecar in Node: flag matcher, signed events, automatic capture, never blocks (S-9)'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/contracts/events/app-events.md', '{project-root}/contracts/instance/instance-contract.md', '{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `services/sidecar/` holds only a `.gitkeep`. The only sidecar is the test stub (`contracts/mocks/stub-instance/sidecar.mjs`), which passes player traffic through, and signs and relays the shop's events, but sees nothing: no `proxy.flag_seen`, no `evidence.capture`, no `proxy.request`. The image role `sidecar` has no product image and `infra/images.json` has no entry for it, so a real instance cannot start with a sidecar. FR-FLG-04, 06 and FR-DET-04 are not met. Handoffs H-76, H-94. Spike S-9 (does the matcher see flags through JSON escaping and gzip, and which channels it cannot see) is not run.

**Approach:** Build the product sidecar as a Node program in `services/sidecar/` (distroless `nodejs24`, like `services/bot/Dockerfile`), taking the logic of the stub sidecar that is already tested against IF-4 (start document once from standard input, write-ahead `seq` file, signing, keep-until-202-or-200, drop on 401, 409, 413, 422 with an alarm, bounded buffer, the answers of `/v1/events`) as its base, and add: (1) a response tee on the player port: bytes go to the player unchanged while a bounded copy (default 1 MiB) is decoded and scanned; (2) a matcher that finds `VM{[A-Z2-7]{24}}` after decoding gzip, deflate and brotli (by `content-encoding`), JSON string escapes, HTML numeric and named entities and percent encoding, hashes each distinct candidate with SHA-256 and looks it up in the digest set of the start document, and classes it `real`, `decoy` or `foreign`; (3) `proxy.flag_seen`, then the matching `evidence.capture` built by the sidecar (method, path with query, redacted headers, request body up to 8 KiB redacted, flag-like strings replaced by `[FLAG-REDACTED]`), and an aggregated `proxy.request` (10 s window, `count`); (4) the image, the `infra/images.json` entry and a run in the existing compose harness in place of the stub sidecar. Decided on the developer's delegation: D-70 (form, shared with story 5), D-73 (matching rules), D-76 (who the sidecar says the player is). Proposed; the main session records them.

## Boundaries & Constraints

**Always:**
- The sidecar never blocks, delays on purpose, rewrites or drops a player request or response. The pass-through stays the first path: headers and body are forwarded as received; the scan works on a copy after the bytes were written; any error in decoding, matching, signing or relay is caught, counted, alarmed (a line with a fixed word and a counter, never a value) and ignored. A test breaks each part in turn (bad digest set, ingest down, relay timeout, decoder throws) and asserts that the player gets the exact bytes.
- Hop-by-hop and `host` handling stay as `passThrough` (`common.mjs:126-148`). Strip `x-vm-*` request headers the player sent before they reach the shop (so a player cannot spoof a header a later gate sets), and never forward `x-vm-*` back out.
- The matcher sees only responses to the player port (8080). The sidecar holds digests, never a flag: `flag_digests` of the start document are `sha256` hex of the real flags and the decoys. A response that is larger than the scan cap, or whose `content-encoding` it cannot decode, is counted (`scan_skipped`) and put in the `proxy.request` aggregate; it is not an error.
- Candidates are sent only as `candidate_sha256`. `kind` is `foreign` for a flag-shaped string that is in no digest, `challenge_key` only for `real` and `decoy` (IF-4 section 7 notes). One `proxy.flag_seen` per distinct candidate per response; a repeat of the same candidate within 60 s on the same `(method, route_template)` is not sent again (a counter only), so a player who reloads does not flood.
- `evidence.capture` (envelope `challenge_key` required) follows a `proxy.flag_seen` of kind `real` at once, with the same `request_ref` (a per-request id of the form `r-` plus 16 Base32 characters, the `id` shape of the schema). Body: the request line, then the request body up to 8 KiB of UTF-8 with the fields `password`, `passwd`, `token`, `secret`, `authorization`, `cookie`, `api_key` blanked in JSON and form bodies, then flag-like strings replaced by `[FLAG-REDACTED]`; headers: allow-list (`user-agent`, `content-type`, `accept`, `referer`, `x-requested-with`, `origin`), values capped to 512, never `authorization` or `cookie`. The response body is never stored. Only the flag-capturing request has a body in an event (D-25).
- `proxy.request` carries ids, classes and counts only: `method` (the enum or `other`), `route_template` (path segments that are all digits, contain a digit, look like a UUID or an order number become `{id}`; the query string is dropped; at most 200 characters), `status`, `resp_len`, `client_class` (`player`). The sidecar events use `source` `sidecar`, `session_kind` `player`, `user_id` null (D-76).
- Events built by the sidecar are validated against the wire schema in the test suite (every event type the sidecar can emit, with Ajv as a dev dependency) and constructed so they pass; the running sidecar validates only events posted by the shop (as the stub does), with Ajv loaded from the image. Ajv and ajv-formats are pinned exactly as in the root `package.json` (8.20.0, 3.0.1).
- The start document is read once from standard input and checked with the same semantic rules as the stub (`semantic.mjs`); the event key never leaves memory; no key, digest or flag in logs.
- The image: distroless `nodejs24` nonroot (digest pinned the way `services/bot/Dockerfile` does), user 65532, read-only root, writable only `/tmp` (tmpfs 16 MB, `noexec`), no shell, `HEALTHCHECK` through `node -e` like the bot, `infra/images.json` entry named `sidecar` with its `healthcheck` argv (absolute path, no shell, no `CMD` item: H-124).
- Spike S-9 is run with tests and its table is written to `docs/assets/story-6-2-sidecar/s9-matcher-channels.md` (seen: plain, JSON `{`-style escapes, `\/`, gzip, deflate, brotli, HTML entities, percent-encoded, split across chunks, inside a JSON string inside HTML; not seen: base64, hex, a reversed or split string, a flag cut by the caller, a response above the cap, a response over another protocol; those use paste, FR-FLG-06).

**Never:**
- Putting anything from `contracts/mocks/**` into the product image (copy the logic, do not import the mock); changing a contract file (IF-4, IF-6 stay as they are; any difference from the stub is reported to the developer as H-94 says); `.github/workflows/**`; terraform; AWS; ssh; docker push; pushes and commits; git checkout, stash or reset; the Excel tracker.
- Reading or storing a response body beyond the scan copy; logging a candidate; adding a route to the sidecar other than `/v1/events`, `/healthz` and the player port pass-through.
- Starting the CRS helper (story 5). The hook for it exists as a no-op function `inspectRequest` that returns nothing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real flag, plain | response body holds the real C05 flag | player gets identical bytes; `proxy.flag_seen` kind real, C05; `evidence.capture` C05 with the same `request_ref` | none |
| Real flag, gzip | `content-encoding: gzip` | same result | undecodable: counted, skipped |
| JSON escapes | body `"VM{ABC...}"` and `\/` forms | same result | none |
| HTML entity / percent | `VM&#123;...&#125;`, `VM%7B...%7D` | same result | none |
| Split across chunks | flag cut at a chunk border | same result (the copy is joined before the scan) | none |
| Decoy | response holds a decoy | kind decoy with its challenge key; no `evidence.capture` | none |
| Foreign | flag-shaped, not in the digests | kind foreign, no challenge key | none |
| Not seen | base64 or hex of a flag | no event; documented in the S-9 table | none |
| Too big | 2 MiB response | no scan, `scan_skipped` counted, bytes identical | none |
| Reload | same candidate twice in 60 s on one route | one event, a counter | none |
| Ingest down | relay refuses | player unaffected; events buffered, bounded, oldest `proxy.request` dropped first, never a flag event | alarm line |
| Matcher throws | forced error | player unaffected; alarm counter | none |
| Posted event | shop posts a valid event | 202, stamped and signed as the stub | the stub's 400, 405, 413, 415, 422, 503 |
| Spoof | player sends `x-vm-session-kind: bot` | header removed before the shop; events still say player | none |
| Bad start doc | extra or missing field | exit 2, no listener | fixed message |
| Restart | sidecar process restarted in one epoch | next `seq` continues from the state file | as the stub |

</frozen-after-approval>

## Code Map

- `contracts/mocks/stub-instance/sidecar.mjs:58-178` (`createSidecar`: write-ahead counter `:25-41`, delivery pump `:93-114`, `enqueue` `:116-133`, events server `:136-165`, player server `:168`) -- the tested behaviour to carry over; `common.mjs:42-99` (`readDocument`), `:112-124` (`sendProblem`, `sendJson`), `:126-148` (`passThrough`); `semantic.mjs` (start document rules); `../fake-ingest/sign.mjs` (`signBody`, the signing reference) and `../fake-ingest/ingest.mjs` (`compileEventSchema`, `schemaErrors`).
- `contracts/mocks/stub-instance/main.mjs:31-39` -- the `sidecar` command and its flags (`--relay`, `--upstream`, `--state`, ports): the product entry point keeps the same flags so the template and harness need no change.
- `services/sidecar/` (new): `src/main.mjs`, `src/sidecar.mjs`, `src/matcher.mjs`, `src/decode.mjs`, `src/capture.mjs`, `src/route.mjs`, `src/events.mjs`, `package.json` (`"type": "module"`, engines `>=24 <25`, deps pinned), `Dockerfile`, `Dockerfile.dockerignore`, `test/*.test.mjs`. Layout follows `services/bot/`.
- `contracts/events/instance-events.schema.json:955-999` (`data_proxy_request`), `:1035-1105` (`data_proxy_flag_seen`), `:1106-1134` (`data_evidence_capture`, the 8192 cap and the `VM{` refusal pattern), `contracts/events/app-events.md:155-199` (catalogue), `:94-103` (key rule); `contracts/instance/sidecar-start.schema.json` -- the documents the sidecar reads and writes; read only.
- `contracts/instance/examples/valid/instance-template/shop-template.json:106-134` -- the sidecar component (256 MB, 0.5 CPU, pids 128, `/tmp` tmpfs 16 MB): the new memory use stays inside it.
- `infra/images.json` -- add the `sidecar` entry (context `services/sidecar`, platform `linux/amd64`, `public`, `healthcheck`); `scripts/images-matrix.mjs` and `scripts/images-release.mjs` read it (check that the tests of those scripts still pass; no workflow edit).
- `infra/compose/harness.yaml:139-158` (the `sidecar` service) -- a second profile or override that runs the product image instead of `vulnmart-stub-instance:local`; `scripts/harness.mjs` and `scripts/harness.test.mjs` for how the harness is started in tests.
- `apps/shop/` -- read only (Sahil owns it): how the shop is reached and what it posts (`apps/shop/src/instance/instance.mjs:64-95`).
- Docs: dev-log, CHANGELOG, traceability (FR-FLG-04, 06, FR-DET-04, S-9, D-01), HANDOFFS (H-76, H-94 answers; rows H-329 for Sahil below), `docs/assets/story-6-2-sidecar/`.

## Tasks & Acceptance

**Execution:**
- [ ] `services/sidecar/src` -- port the stub sidecar logic (counter, signing, pump, events server) into product modules; a parity test runs the stub's own `sidecar.test.mjs` cases against the product code (copy the cases, not the file)
- [ ] `matcher.mjs`, `decode.mjs` -- bounded tee, decoders, candidate extraction, SHA-256 lookup; table-driven tests for every row of the matrix and the S-9 channel table
- [ ] `capture.mjs`, `route.mjs`, `events.mjs` -- `evidence.capture` with redaction and the caps, route templates, aggregated `proxy.request`, `request_ref`; every emitted event validated against `instance-events.schema.json` in a test
- [ ] never-block tests -- break each part and compare the bytes the player receives
- [ ] `Dockerfile`, `infra/images.json` -- build the image locally (`docker build -f services/sidecar/Dockerfile services/sidecar`), record size and digest; run the harness with the product image and the stub shop and fake ingest: a request that returns a flag shows the three events in the fake ingest
- [ ] S-9 table and docs as in the Code Map

**Acceptance Criteria:**
- Given a stub shop that returns the injected flag of one challenge (plain, gzip, JSON-escaped), then the fake ingest holds a valid signed `proxy.flag_seen` (real, right challenge) and `evidence.capture`, no event holds a flag value, and the player received identical bytes.
- Given a decoy or a flag of another instance, then the events are `decoy` or `foreign` and no capture is sent.
- Given the ingest is unreachable, a decoder error or a bad digest set, then the player still receives every response unchanged.
- Given the S-9 tests, then the table of seen and not seen channels is saved.
- Given the image, then it starts under the runtime profile (read-only root, user 65532, no capabilities) and passes the health check; its size is recorded.

## Verification

**Commands (Windows dev PC, Docker Desktop running for the image steps):**
- `node --test services/sidecar/test` -- expected: pass
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"` (the root `pnpm test`) -- expected: pass, the stub tests unchanged
- `docker build -f services/sidecar/Dockerfile -t vulnmart-sidecar:local services/sidecar` -- expected: builds; `docker image inspect vulnmart-sidecar:local --format "{{.Size}}"` recorded
- `node scripts/harness.mjs` with the sidecar override (exact line recorded when built) and `node scripts/scan-flags.mjs --instance <harness>` from story 1 -- expected: events present, scan clean
- `node scripts/check-instance-conformance.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

**Local only / developer runbook:** the image is built and its digest enters the release manifest by the images workflow from `main` (the push is the developer's); the run on `vm-i` with a real shop is the live check of the epic (T-32).

## Proposed (decided on the developer's delegation)

- **D-70 Sidecar form (S-7), recorded with story 5.** A Node program for everything the contracts need, because its behaviour already exists and is tested in the stub and Node 24 is the runtime of the rest of the instance; a small Go helper for Coraza only (story 5). A Caddy plugin is rejected (maintenance risk R-6, and flag matching, signing and `seq` would still need a Go module); a full Go rewrite is rejected (about two days of work for no gain the demo needs, no Go toolchain on the dev PC).
- **D-73 Matching.** Scan a bounded copy (1 MiB) after decoding gzip, deflate, brotli, JSON escapes, HTML entities and percent encoding; look up SHA-256 digests; report once per candidate; what the matcher cannot see is the paste channel (FR-FLG-06).
- **D-76 Who the player is.** Everything on the player port is the owning player (the gate admits only the owner): `session_kind` `player`, `user_id` null; the platform maps the instance to the attempt and user. The bot and the mock services reach the shop on the instance network and never use the player port. If the bot must use it, it needs a marker the sidecar can trust: see Open.

## Open (not settled here)

- How the bot controller reaches the shop (directly on the instance network, assumed) and whether any traffic on the player port can be the bot: a question for Sahil (T-13), handoff H-329. Risk: if bot traffic arrives on the player port it would be classed as a player; the engine still ignores events marked `bot` from the shop.
- The matcher cannot see C06's `auditToken` unless the response passes the sidecar (the import service answers over the shop, so it does) and C10's flag if the shop strips it; the shop owns those; flagged in H-329.

## Implementation Notes

Built 2026-10-17 (local run on the Windows dev PC, Docker Desktop 29.6.2, Node 24.11.0). Raw output: `docs/assets/story-6-2-sidecar/test-output.txt`; S-9 table: `docs/assets/story-6-2-sidecar/s9-matcher-channels.md`.

**What exists (`services/sidecar/`):** `src/main.mjs` (entry, same flags as the stub, optional leading word `sidecar`, exit 2 on a bad start document), `sidecar.mjs` (events server on 9000, player port 8080 with the response and request tee, `inspectRequest` no-op hook), `outbox.mjs` (write-ahead `seq` file, signing, keep-until-202-or-200, drop on 401/409/413/422, bounded buffer), `matcher.mjs`, `decode.mjs`, `capture.mjs`, `route.mjs`, `events.mjs`, `sign.mjs`, `start.mjs`, `common.mjs`, `schemas/` (3 copies of contract schemas), `scripts/sync-schemas.mjs`, `scripts/s9-table.mjs`, `test/*.test.mjs`, `Dockerfile`, `Dockerfile.dockerignore`, `package.json`, `pnpm-lock.yaml`. Also `infra/images.json` (new `sidecar` entry), `infra/compose/harness.sidecar.yaml` (override that runs the product image), root `pnpm-lock.yaml` (importer added).

**Real results (local):**
- `node --test "services/sidecar/test/*.test.mjs"`: 49 tests, 49 pass, 0 fail, 0 skipped (48 without Docker, plus the image test with a real Docker daemon).
- Stub instance tests unchanged: 55 pass. `scripts/images-matrix.test.mjs`: 9 pass. `node scripts/images-matrix.mjs` lists `sidecar`. `check-text-files` and `scan-secrets`: PASS. `scan-flags --image` on the built image and `--file` on the S-9 table: CLEAN.
- Image (local, amd64, Docker Desktop content size): 53,073,687 bytes (50.6 MiB). Idle memory under `docker stats` after the flag request and one posted event: 30 to 52 MiB over three runs (limit 256 MiB). Started with `--read-only --user 65532:65532 --cap-drop ALL --no-new-privileges`, tmpfs `/tmp` 16 MB noexec, 256 MB, 0.5 CPU, 128 pids: healthy, gzip flag response passed through byte for byte, signed `proxy.flag_seen` and `evidence.capture` accepted by the fake ingest (no signature problem), no key or flag in the container settings or log.
- The Docker test builds its own tagged and labelled image, container and removes both; leftovers check after the run: none. The test image tag `vulnmart-sidecar:local` made for the first manual build was removed too. BuildKit cache layers stay in Docker (not labelled).
- S-9: 27 channel rows, 0 mismatches. Seen: plain, JSON plain, JSON `\u` escapes (braces and every character), `\/`, gzip, deflate, brotli, gzip around JSON escapes, HTML entities (numeric, named, all characters), percent (braces, all), JSON inside HTML, HTML inside JSON, chunk border. Not seen: base64, hex, reversed, split by markup, cut by the caller, lower case, UTF-16, undecodable `content-encoding` (zstd), response above 1 MiB.

**Decisions made while building (all inside the plan; the main session records them):**
1. The image build context is `services/sidecar` only, so the three schemas the sidecar loads are vendored in `services/sidecar/schemas/` with `scripts/sync-schemas.mjs`; a test fails if a copy differs from `contracts/` by one byte.
2. The package has its own `pnpm-lock.yaml` (made with `--ignore-workspace`, like `apps/shop`) for the Docker install, and the root `pnpm-lock.yaml` gained the importer. The root lock update also added empty importers for `services/bot`, `services/import-service` and `services/mock-services` (their `package.json` existed; pnpm wrote them).
3. Buffer rule: a full buffer drops the oldest `proxy.request` first. If the buffer holds only flag, evidence or shop events, a new summary is dropped itself (takes no seq); a new non-summary event then drops the oldest event overall, the rule of the stub (and its parity test).
4. `proxy.request` aggregate: key is (method, status, route template); `resp_len` is the largest in the window; `count` is always set (clamped to 1,000,000); at most 200 keys per window (more are counted in `aggregate_overflow`).
5. Evidence safety: after redaction, if any decoded form of the body or a header value still holds a flag shape or a schema-refused pattern, the whole value is replaced by `[FLAG-REDACTED]` (fail closed).
6. Route templates: a segment longer than 40 characters also becomes `{id}` (an addition to the plan rules, to keep tokens out); a segment such as `v2` becomes `{id}` too, as the plan rule "contains a digit" says.
7. Candidate dedupe window is fixed from the first send (a repeat does not extend it); an evidence capture is sent only with the first `real` event.

**Deviations from the plan text:**
- `node --test services/sidecar/test` does not work on Node 24 (a directory is treated as a module path); the command is `node --test "services/sidecar/test/*.test.mjs"` (also the package `test` script).
- Harness: `scripts/harness.mjs` starts the stack from `harness.yaml` only and has no option to add an override file, so the full compose run with the product image was NOT done. Done instead: the override file resolves with `docker compose config` and passes `checkConfig` (20 rules PASS); the real-Docker test runs the image under the same runtime profile against a fake ingest and a scripted shop on the host. A full harness run with the override is still to do (needs `scripts/harness.mjs` to accept a second compose file, outside this story's files).
- `scan-flags --instance <harness>` was not run (no harness instance exists); `--image` and `--file` were run instead.
- The compose command for the product image is `["/app/src/main.mjs", "--relay", ..., "--upstream", ...]` (distroless entry point is `node`; the stub's word `sidecar` also works but is not needed).

**Open for the main session:** H-76 and H-94 answers (the product sidecar equals the stub on every case copied from its tests; differences from the stub: none found, and extra behaviour = the three sidecar events, `x-vm-*` stripping, priority drop); the H-329 row for Sahil (T-13: how the bot reaches the shop; C06 `auditToken` and C10 flag visibility through the sidecar); D-70, D-73, D-76 records; `check-instance-conformance` and the images workflow run on `main` (not run here).