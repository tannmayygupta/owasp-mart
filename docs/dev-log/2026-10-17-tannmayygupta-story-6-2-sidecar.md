# Real sidecar in Node: flag matcher, signed events, capture (story 6.2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: product sidecar and image built, tests passed on Docker Desktop; the full compose harness run with the product image was not done, the Coraza helper (story 5 of the epic) is not built, nothing ran on vm-i |
| Report tag | sidecar, flag matcher, evidence capture, spike S-9, FR-FLG-04, FR-FLG-06, FR-DET-04, D-70, D-73, D-76 |

## Requirements covered
FR-FLG-04, FR-FLG-06, FR-DET-04; spike S-9 (run locally); D-01; decisions D-70, D-73, D-76 (Proposed, in ADR 0042); handoffs H-76 and H-94 (answered as built), H-332 (new). Task L-20 (part; stays unticked: Coraza and classifier accuracy S-6 are not built).

## Summary (plain language, 3-5 lines)
`services/sidecar/` held only a `.gitkeep`. It now holds a real sidecar that passes player traffic through unchanged while scanning a bounded copy of each response for flags after decoding gzip, deflate, brotli, JSON escapes, HTML entities and percent encoding. It sends signed `proxy.flag_seen`, `evidence.capture` and aggregated `proxy.request` events and never sends a flag value. It builds into a small distroless image and starts under the runtime profile.

## Why
The only sidecar was the test stub, which saw nothing. The image role `sidecar` had no product image, so a real instance could not start with one. FR-FLG-04, 06 and FR-DET-04 were not met; spike S-9 (which channels the matcher can and cannot see) was not run.

## What was built
- `services/sidecar/`: `src/main.mjs` (same flags as the stub), `sidecar.mjs` (events server 9000, player port 8080 with response and request tee, `inspectRequest` no-op hook for the later Coraza helper), `outbox.mjs` (write-ahead `seq` file, signing, keep until 202 or 200, drop on 401, 409, 413, 422, bounded buffer), `matcher.mjs`, `decode.mjs`, `capture.mjs`, `route.mjs`, `events.mjs`, `sign.mjs`, `start.mjs`, `common.mjs`, `schemas/` (3 vendored contract schemas), `scripts/`, `test/*.test.mjs`, `Dockerfile`, `package.json`, `pnpm-lock.yaml`.
- `infra/images.json` (new `sidecar` entry), `infra/compose/harness.sidecar.yaml` (override that runs the product image), root `pnpm-lock.yaml` (importer added).
- S-9 table `docs/assets/story-6-2-sidecar/s9-matcher-channels.md`.

## How it works
Bytes go to the player unchanged first; a bounded copy (1 MiB) is decoded and every `VM{...}` shaped candidate is hashed with SHA-256 and looked up in the digest set from the start document: `real`, `decoy` or `foreign`. Only `candidate_sha256` is sent. A real flag is followed by an `evidence.capture` with the request line, a body up to 8 KiB with sensitive fields blanked and flag-like strings replaced, and an allow-listed set of headers. Everything on the player port is the owning player (`session_kind` `player`, `user_id` null; the gate admits only the owner). Any error in decoding, matching, signing or relay is counted and ignored; the player always gets the same bytes. `x-vm-*` request headers are stripped before the shop.

## Files changed
- `services/sidecar/**` - new (see above)
- `infra/images.json`, `infra/compose/harness.sidecar.yaml`, `pnpm-lock.yaml` - changed / new
- `docs/assets/story-6-2-sidecar/{test-output.txt,s9-matcher-channels.md}`
- Docs: this entry, ADR 0042, `initial.md` (D-70, D-73, D-76), HANDOFFS, CHANGELOG, traceability, dev1 file

## Decisions made
D-70 (Node sidecar plus a later small Go helper for Coraza only; Caddy plugin rejected for maintenance risk R-6 and because flag matching, signing and `seq` would still need a Go module; full Go rewrite rejected for about two days of work and no Go toolchain on the dev PC), D-73 (matching rules), D-76 (who the player is). Built-in choices to confirm: the three schemas are vendored with a test that fails on a one-byte difference from `contracts/`; a full buffer drops the oldest `proxy.request` first and a flag, evidence or shop event is never dropped before a summary; `proxy.request` aggregate keyed by (method, status, route template) with at most 200 keys per window; evidence is replaced whole by `[FLAG-REDACTED]` if any decoded form still holds a flag shape (fail closed); route segments longer than 40 characters or containing a digit become `{id}`; the dedupe window is fixed from the first send. See ADR 0042.

## Tests
Raw output in `docs/assets/story-6-2-sidecar/test-output.txt`.
- `node --test "services/sidecar/test/*.test.mjs"`: 49 tests, 49 pass, 0 fail, 0 skipped (48 without Docker plus the image test with a real Docker daemon).
- Stub instance tests unchanged: 55 pass. `scripts/images-matrix.test.mjs`: 9 pass. `node scripts/images-matrix.mjs` lists `sidecar`. `check-text-files` and `scan-secrets`: PASS (as recorded by the implementer; other stories' runs in the same tree saw one text-file FAIL in `services/sidecar/test/events.test.mjs:68`, a replacement character, since then outside this entry's control). `scan-flags --image` on the built image and `--file` on the S-9 table: CLEAN.
- Image (local, amd64, Docker Desktop content size): 53,073,687 bytes (50.6 MiB). Idle memory under `docker stats` after the flag request and one posted event: 30 to 52 MiB over three runs (limit 256 MiB). Started with `--read-only --user 65532:65532 --cap-drop ALL --no-new-privileges`, tmpfs `/tmp` 16 MB noexec, 256 MB, 0.5 CPU, 128 pids: healthy, gzip flag response passed through byte for byte, signed `proxy.flag_seen` and `evidence.capture` accepted by the fake ingest, no key or flag in container settings or log.
- S-9: 27 channel rows, 0 mismatches. Seen: plain, JSON plain, JSON `\u` escapes, `\/`, gzip, deflate, brotli, gzip around JSON escapes, HTML entities, percent encoding, JSON inside HTML, HTML inside JSON, chunk border. Not seen: base64, hex, reversed, split by markup, cut by the caller, lower case, UTF-16, undecodable `content-encoding` (zstd), a response above 1 MiB.
- Leftovers after the run: none; BuildKit cache layers stay in Docker.
- NOT run: a full harness run with the override, `scan-flags --instance`, `check-instance-conformance`, the images workflow.
Traceability rows: FR-FLG-04, FR-FLG-06, FR-DET-04, S-9, D-01.

## Evidence
`docs/assets/story-6-2-sidecar/test-output.txt`, `docs/assets/story-6-2-sidecar/s9-matcher-channels.md`.

## Problems met and how they were fixed
- `node --test services/sidecar/test` does not work on Node 24 (a directory is treated as a module path); the command is `node --test "services/sidecar/test/*.test.mjs"`, also the package `test` script.
- `scripts/harness.mjs` starts the stack from `harness.yaml` only and cannot add an override file, so the full compose run was not done; instead the override resolves with `docker compose config` and passes `checkConfig` (20 rules PASS), and the Docker test runs the image under the same runtime profile against a fake ingest and a scripted shop on the host.
- The root `pnpm-lock.yaml` update also added empty importers for `services/bot`, `services/import-service` and `services/mock-services` (pnpm wrote them).

## Security notes (vulnerable parts only)
Not a vulnerable part of the shop; this is platform detection. The sidecar holds digests, never a flag; it never blocks or rewrites a player request; the event key never leaves memory. What it cannot see (base64, hex, reversed or split strings) is covered by the paste channel (FR-FLG-06).

## Limitations and follow-ups
- Coraza and CRS (story 5 of the epic) and classifier accuracy (S-6) are not built; `inspectRequest` is a no-op.
- The full harness run with the product image needs `scripts/harness.mjs` to accept a second compose file (outside this story's files).
- Open for Sahil (H-332): how the bot reaches the shop, and whether C06's `auditToken` and C10's flag pass through the sidecar.
- Difference from the stub on every case copied from its tests: none found; extra behaviour is the three sidecar events, `x-vm-*` stripping and the priority drop.
- Live run on vm-i with a real shop is T-32 (not run).
