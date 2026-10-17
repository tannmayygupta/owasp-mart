# Coraza and Core Rule Set detect-only helper, sidecar integration, S-6 accuracy (story 6.5)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `4b52c21` (the earlier session had already committed `services/sidecar/crs/` there); not committed when this entry was written |
| Status | Done for the build and the local measurements; not done: the full compose harness run, anything on vm-i, paranoia levels above 1. `classifier_accuracy_verified` is not set by this story (see Limitations) |
| Report tag | Coraza, OWASP Core Rule Set, detect-only, sidecar, S-6, S-7, FR-DET-01, FR-DET-02, FR-DET-04, FR-DET-07, D-70, OI-35 |

## Requirements covered
FR-DET-01, FR-DET-02, FR-DET-04, FR-DET-07; spikes S-6 and S-7; OI-35 (CRS tag names, partly); R-6; D-70 (Proposed in the plan); handoff H-76 (rule matches) and the new tag-mapping handoff H-133 (text in the plan, row added by the main session). Task L-20 (the Coraza part).

## Summary (plain language, 3-5 lines)
The sidecar now asks a small Go helper, `crs-detect` (Coraza v3 with the OWASP Core Rule Set, detection only), about each player request after the answer has been sent, and turns a match into a `proxy.crs_match` event. A missing, slow, busy or crashed helper changes nothing for the player. The helper ships inside the same distroless sidecar image. On the local corpus CRS sees SQL injection, XSS, SSRF by address and the prototype keys of C06, and nothing of the logic-bug challenges (expected). Resident memory of the helper is about 64 MiB against the 256 MiB limit.

## Why
The story-6.2 sidecar reported flags but ran no rule set, so `proxy.crs_match` was never sent (FR-DET-02), the technique label had no source and S-6 and S-7 were open. PRD risk R-6 says the Coraza Caddy plugin needs a maintainer, so the plan chose the Node sidecar plus a small helper (D-70).

## What was built
What already existed (earlier session, committed in `4b52c21`): `services/sidecar/crs/main.go`, `go.mod`, `go.sum`, `directives.conf`, `crs_test.go` (9 Go tests), and a scratch file `.out` (a saved copy of one test run, no code; deleted now). I re-ran the 9 tests first: all passed, so I extended instead of restarting.

Added in this task:
- `services/sidecar/src/crs.mjs` (new): supervisor (spawn without a shell, `--listen 127.0.0.1:9100`, restart at most 3 times in a minute, then one alarm line and no more tries), the call (300 ms timeout, at most 8 in flight, extra calls skipped and counted, answer size cap), the tag map, the rule id and score mapping, and the document builder (no cookie, authorization or `x-vm-*` header, flag-like text and credentials blanked, body cut to 8 KiB).
- `services/sidecar/src/sidecar.mjs`: the `inspectRequest` hook became real (`inspectRequest(crs, info)`), called in `afterResponse` through `setImmediate`, so after the answer has been handed to the socket; new option `crs`; new counters `crs_events`, `crs_errors`; the helper is stopped with the sidecar. Without a helper the hook returns `undefined` as before (an old test still asserts that).
- `services/sidecar/src/events.mjs`: `crsMatchEvent`. `src/main.mjs`: `--no-crs` (a flag without a value, removed before the strict flag parser), default on only when `/app/crs-detect` exists, optional `--crs-binary PATH` for tests.
- `services/sidecar/Dockerfile`: new builder stage `golang:1.25-bookworm` pinned by digest, `CGO_ENABLED=0`, `-trimpath`, `-ldflags "-s -w"`, `go mod download && go mod verify`; the binary is copied to `/app/crs-detect` in the distroless nodejs24 image. `Dockerfile.dockerignore` keeps the Go test, corpus and `.out` out of the build context.
- `services/sidecar/crs/directives.conf`: one rule added, `tx.allowed_methods` widened to PUT, PATCH, DELETE (the shop uses them). `crs_test.go`: one test added (`TestShopMethodsAreNotFlagged`).
- `services/sidecar/crs/corpus.json` (32 exploit requests of the 11 challenges, 60 hand-written benign requests), `scripts/crs-accuracy.mjs`, `scripts/crs-accuracy.test.mjs`.
- `services/sidecar/test/crs.test.mjs` (15 Node tests, fake helper), `services/sidecar/test/docker.test.mjs` extended (SQLi through the real image).
- `docs/assets/story-6-5-coraza/s6-accuracy.md`, `test-output.txt`.

## How it works
Player request -> shop -> answer piped to the player. When the upstream answer has ended, a macrotask later, the sidecar builds the document (redacted as above) and POSTs it to the helper on loopback. The helper runs the request phases only (connection, URI, headers, body up to 8 KiB, `ProcessPartial`), never the response, never reads `tx.Interruption()`, and answers `{rule_ids, tags, anomaly_score}`; it keeps only rules that carry an `attack-*` tag and id 900000 or higher, so the bookkeeping rules do not count. The sidecar maps tags (only `attack-`, `language-`, `platform-`; lower case; every other character to `_`; cut at 32; at most 20), keeps numeric rule ids (3 to 9 digits, at most 50), caps the score at 10000 and, if there is at least one rule id, emits `proxy.crs_match` with the route template (low priority, like `proxy.request`). Nothing from the helper's answer other than those three fields can reach the event or the player (tested with an answer that carries `action: deny`).

## Files changed
See What was built. Not touched: `contracts/**`, the catalogue, `.github/**`, terraform, `infra/images.json` (the sidecar entry already points at this Dockerfile), other components, CHANGELOG, traceability, HANDOFFS, trackers.

## Decisions made
D-70 as written in the plan (Node sidecar plus Go helper, loopback, off the response path, tag mapping). The ADR is written by the main session. Built-in choices to confirm: the helper only reports rules with an `attack-*` tag; `tx.allowed_methods` widened (documented, tested, not a paranoia change); an `--image`/`--url` split in the accuracy script; the helper's call uses a fresh connection per call (`agent: false`); `proxy.crs_match` is sent as a low-priority event.

Exact versions that resolved (from `go.mod`, verified with `go list -m` in the build image):
- `github.com/corazawaf/coraza-coreruleset/v4 v4.25.0`, which embeds OWASP CRS 4.25.0 (652 rules carry `ver:'OWASP_CRS/4.25.0'`). The PRD and the plan say v4.30.0: that version does not exist as a module version today; the newest listed by the Go proxy is v4.25.0 (list: ... v4.23.0, v4.24.0, v4.24.1, v4.25.0). The ADR should say CRS 4.25.0.
- `github.com/corazawaf/coraza/v3 v3.8.1` (v3.8.0 and v3.8.1 are the newest), `github.com/jcchavezs/mergefs v0.1.1`, Go 1.25.14 (go.mod says `go 1.25.0`). Other modules: see `go.mod` (unchanged, `go.sum` unchanged).
- Builder image `golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437` (that exact digest is in the Dockerfile and in the Go test command). Node builder `node:24.21.0-bookworm-slim@sha256:d6aa754f...87b20` and runtime `gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e25...32d0a` are the pins of story 6.2, unchanged.

## Tests
All run on this PC (Windows, Docker Desktop 29.6.2, amd64). Raw output: `docs/assets/story-6-5-coraza/test-output.txt`.
- Helper, in Docker: `docker run --rm --label vulnmart=story-6-5 -v "${PWD}/services/sidecar/crs:/src" -v vm-gomod:/go/pkg/mod -w /src golang:1.25-bookworm@sha256:3b4a1151... sh -c "gofmt -l .; go vet ./... && go test -count=1 -v ./..."`: gofmt prints nothing, vet clean, 10 tests, 10 pass (9 before, plus the methods test). Includes `TestDetectOnlyNeverInterrupts` (request far above the blocking threshold, no interruption, no action field in the answer type) and `TestNoEngineOnAnywhere`.
- Node: `node --test "services/sidecar/test/*.test.mjs" scripts/crs-accuracy.test.mjs`: 69 tests, 69 pass, 0 fail, 0 skipped (49 before + 15 in `crs.test.mjs` + 5 in `crs-accuracy.test.mjs`; the image test ran with the Docker daemon up, it is not skipped). The 15 cover the tag map, rule ids and score, the redacted document, SQLi (event valid at the fake ingest, answer byte-identical to a run without the helper, player not waiting for the helper), SSRF, benign and logic-bug, detect-only answer with an action field, helper down, helper slow (700 ms answer, 300 ms limit), busy (14 requests, 8 calls, 6 skipped), garbage answers, 20 KiB body cut to 8 KiB, no binary and `--no-crs`, and the supervisor (4 starts, 3 restarts, one alarm, no shell).
- Image: `docker build -f services/sidecar/Dockerfile -t vulnmart-sidecar:local --label vulnmart=story-6-5 services/sidecar`: builds in about 43 s (cold Go module cache); size 58,324,760 bytes (55.6 MiB; was 53,073,687 before the helper). The image test starts it under the runtime profile (read-only, user 65532, cap-drop ALL, no-new-privileges, tmpfs `/tmp`, 256 MB, 0.5 CPU, 128 pids): healthy, an SQLi request through the player port gave a valid `proxy.crs_match` with `attack_sqli` at the fake ingest and the player got the shop answer unchanged, a benign search added no `attack_sqli` event, no key or flag in the container log. `docker stats` of the whole container (Node plus helper) after those requests: 69.12 MiB of 256 MiB (earlier runs 71.69 MiB).
- S-6: `node scripts/crs-accuracy.mjs --image vulnmart-sidecar:local` -> `docs/assets/story-6-5-coraza/s6-accuracy.md`. Headline: CRS saw 15 of 32 exploit requests (C03 all 8, C06 both, C10 5 of 6; nothing for the logic-bug challenges and C05, as expected); 31 of 32 in the right family (the miss is C10 with the internal name `metadata.vulnmart.internal`, which CRS has no rule for); false positives 0 of 60 benign requests; `/inspect` latency p50 3.11 ms, p95 64.67 ms, p99 80.78 ms (500 calls, inside the container); helper resident memory 63.7 MiB (VmRSS and VmHWM), `docker stats` 55.32 MiB, limit 256 MiB. Labelled local Docker Desktop, paranoia level 1, 0.5 CPU limit (not "one CPU share": the container is limited to 0.5 CPU, as in the instance template).
- Tags seen (OI-35, CRS part): `attack-sqli`, `attack-xss`, `attack-ssrf`, `attack-rfi`, `attack-injection-generic`, `attack-rce`, `attack-generic`, `attack-protocol`, plus `language-multi`, `language-javascript`, `platform-multi`, `platform-nodejs`. So `attack_ssrf` exists in CRS 4.25.0.
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`: PASS. `node scripts/scan-flags.mjs --image vulnmart-sidecar:local`, and `--file` on `s6-accuracy.md` and `corpus.json`: CLEAN. (check-text-files covers tracked files, so the new untracked files were also checked by hand: no BOM, no non-ASCII byte.)
- Repository search for `SecRuleEngine On`: found only in the plan document (prose) and in `crs_test.go` (the assertion that forbids it); none in the helper, the directives or any other file.
- NOT run: the full compose harness with the product image (`scripts/harness.mjs` cannot take the override file, same as story 6.2), anything on vm-i, paranoia levels 2 to 4, `scan-flags --instance`.

## Evidence
`docs/assets/story-6-5-coraza/s6-accuracy.md` (the S-6 table), `docs/assets/story-6-5-coraza/test-output.txt`.

## Problems met and how they were fixed
- The helper does a file system check at start and writes a temporary file under `/tmp`: under `--read-only` without a writable `/tmp` it exits with "filesystem access check: create file ... read-only file system" (Coraza suggests the `no_fs_access` build tag). The sidecar runtime profile already has a tmpfs `/tmp`, so the instance is fine; my first accuracy run failed until I gave the test container the same tmpfs. Recorded so nobody starts the helper read-only without `/tmp`.
- First accuracy run: 23 of 60 benign requests flagged. Cause: my corpus had no Content-Length on POSTs and CRS rule 920180 flags that (a real client sends it); the script now adds the header. A second run showed 3 flagged (rule 911100: PUT, PATCH, DELETE are not in the CRS default method list); fixed in `directives.conf` with a Go test. Final: 0 of 60. Both steps are written in the S-6 file.
- My first fake-helper test replied 403 because the fake used the same field name (`status`) as the answer under test; fixed in the test (the real helper has no such field).
- The Docker test first took the earlier `attack_protocol` event for the SQLi one and then counted a late event of its own second request; fixed by selecting events with the `attack_sqli` tag and waiting before counting.
- Not a dead end but worth knowing: the earlier-session `.out` file was a test log, not code.

## Security notes (vulnerable parts only)
Not a vulnerable part of the shop; this is platform detection. The helper is DetectionOnly: it has no way to answer with an action, listens on loopback only (a Go test refuses any other address), never reads the response and makes no outbound call. It receives no cookie, authorization header, `x-vm-*` header, credential or flag-shaped text. Its logs are counters only. The corpus holds invented hosts and codes only; no flag, key or credential.

## Limitations and follow-ups
- The accuracy is mixed, and the table says so: CRS names SQLi and XSS well, SSRF by address (not by an internal name), C06 only as a generic injection at score 5 (the CRS blocking threshold), and nothing for the six logic-bug challenges and C05. The challenges that are not request-content attacks must keep using app events. `classifier_accuracy_verified` stays false here; the developer decides (FR-DET-07).
- 60 benign requests is a small sample; the real false-positive rate and the memory under real traffic are runbook steps on vm-i (`docs/runbooks/detection-live-check.md`).
- p95 latency (about 65 ms) is far above p50 (about 3 ms); the cause was not investigated.
- The plan says CRS v4.30.0; the module resolves to CRS 4.25.0 (see Decisions). The ADR and PRD text need the correction.
- Handoff text for H-133 (tag mapping `attack-sqli` to `attack_sqli`, filter, caps) and an answer for H-76 are for the main session to record.
- The full harness run with the product image still needs `scripts/harness.mjs` to accept a second compose file (outside this story).
