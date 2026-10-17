---
title: 'Coraza and Core Rule Set detect-only helper, classifier accuracy and the sidecar form (S-6, S-7)'
type: 'feature'
ticket: '5'
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
context: ['{project-root}/docs/prd/PRD.md', '{project-root}/contracts/events/app-events.md', '{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The sidecar of story 2 reports flags but runs no rule set, so `proxy.crs_match` is never sent (FR-DET-02), the technique label has no source, and the spikes S-6 (which CRS tags, false positives, latency, classifier accuracy) and S-7 (sidecar form) are open. PRD risk R-6 says the Coraza Caddy plugin needs a maintainer. FR-DET-02 and FR-DET-07 are not met. Handoff H-76 (rule matches).

**Approach:** S-7 decided as: the sidecar stays the Node program of story 2, and a small Go helper `crs-detect` embeds Coraza v3 and the Core Rule Set v4 (the `coraza-coreruleset` module, free Apache-2.0 licences for Coraza, CRS and distroless) in `DetectionOnly` mode. The helper is a child process of the Node sidecar inside the same image, listening only on `127.0.0.1:9100`, with one call `POST /inspect` (method, URI, headers, request body up to 8 KiB) answering `{rule_ids, tags, anomaly_score}`. It evaluates the request phases only (connection, URI, request headers, request body), never the response, and never answers anything the sidecar uses to block. The Node sidecar calls it after the player's response has been sent (off the response path), with a 300 ms timeout, at most 8 calls in flight (others are counted and skipped), and sends `proxy.crs_match` for each request with at least one match. Missing, crashed or slow helper: the sidecar keeps passing traffic and sending flag and app events; the challenges then use app events (`shop.catalog_query_error` for C03 part A). An accuracy script `scripts/crs-accuracy.mjs` runs a labelled corpus against the helper and writes the S-6 table. Decided on the developer's delegation: D-70 (form, with the tag mapping). Proposed; the main session records them.

## Boundaries & Constraints

**Always:**
- `DetectionOnly`: the Coraza directives start with `SecRuleEngine DetectionOnly`, `SecRequestBodyAccess On`, `SecRequestBodyLimit 8192`, `SecRequestBodyLimitAction ProcessPartial`, `SecResponseBodyAccess Off`, `SecAuditEngine Off`, `SecDebugLog` off; a test asserts there is no `deny`, `drop`, `redirect`, `block` action outcome in any answer, that `SecRuleEngine On` appears nowhere in the repository, and that `tx.Interruption()` is never read to alter anything. The helper has no way to talk to the player: it only listens on loopback and answers the sidecar.
- Paranoia level 1 (CRS default) for the demo; the level is a start flag, not a request value. The CRS version is pinned in `go.mod` and recorded with its source in the dev-log; PRD and ADR say v4.30.0: record the exact module version that resolves and any difference in the ADR (the Go module name `github.com/corazawaf/coraza-coreruleset/v4` versions follow CRS releases; verify at build, do not assume).
- Tags are mapped for the schema: the `proxy.crs_match` `tags` items must match `^[a-z0-9_]{1,32}$` (`instance-events.schema.json:928-931`), so a CRS tag such as `attack-sqli` is sent as `attack_sqli` (lower case, every other character to `_`, cut at 32), only tags beginning `attack-`, `language-` or `platform-` are kept, at most 20; rule ids are the numeric CRS ids (3 to 9 digits), at most 50; `anomaly_score` is the integer inbound anomaly score (the TX variable name is verified in the spike) capped at 10000; `route_template` as story 2.
- The helper receives no flag, no digest, no key and no cookie or authorization header (the sidecar removes them before the call); the body it sees is the redacted capture body of story 2 (credentials blanked) cut to 8 KiB; nothing it receives is logged (its logs are counters only).
- Image: a multi-stage Dockerfile: a pinned `golang` builder image (digest recorded when built; Go is not installed on the dev PC, the build runs in Docker) with `CGO_ENABLED=0`, `-trimpath`, stripped; the static binary is copied into the same distroless `nodejs24` image as the sidecar at `/app/crs-detect`; no shell; the Node sidecar starts it with `child_process.spawn` (no shell) and restarts it at most 3 times in a minute, then stops trying (counter, alarm). The image still runs read-only with user 65532 and fits the 256 MB sidecar limit: resident memory with CRS loaded is measured and written down; if it does not fit, the paranoia-level 1 rule subset is loaded (files named in the spike table) before any template change is proposed.
- Accuracy (S-6, FR-DET-07): `scripts/crs-accuracy.mjs` takes a corpus file `services/sidecar/crs/corpus.json` of labelled requests: the exploit requests of the 11 challenge specs that are request-visible (`challenge-specs.md`: C03 UNION search, C05 `/_ops/diagnostics`, C07 reset confirm brute force, C08 webhook with the sandbox header, C10 import URL to `169.254.169.254` and `metadata.vulnmart.internal`, C06 prototype keys, C01 foreign order number, C02 redeem, C04 refunds, C09 legacy login, C11 array tax id), each labelled with the challenge and the expected family (`sqli`, `ssrf`, `none` for logic bugs), and at least 50 benign requests of normal shop use (browse, search with ordinary words, login, checkout, seller forms) written by hand from the stub and the shop routes. Output: per challenge detected or not with tags and score; the false-positive rate on benign traffic; latency of `/inspect` (p50, p95, p99 over 500 calls) and the process's resident memory; written to `docs/assets/story-6-5-coraza/s6-accuracy.md` and labelled "local Docker Desktop, paranoia level 1, one CPU share". Logic bugs (C01, C02, C04, C08, C09, C11) are expected `none`: "access-control and business-logic challenges use app events, not rule hits" (FR-DET-02 AC); that is a result, not a failure.
- If the measured accuracy is poor or the helper cannot be built in time, the decision is recorded as such: `classifier_accuracy_verified` stays false (story 4), time is shown as estimated and assessment-level only (FR-DET-07 AC), and the sidecar ships without the helper (a start flag `--no-crs`, default on only when the binary exists).
- The sidecar's `inspectRequest` hook of story 2 is the only place the helper is called; the rest of the sidecar does not change.

**Never:**
- Blocking, delaying, rewriting or failing any player request or response because of a rule match, a timeout or a helper crash; calling the helper before the response bytes are on their way; response-body rules.
- A Caddy build, a Caddy plugin, `xcaddy`, or a Traefik plugin; the full Go rewrite of the sidecar.
- Putting the helper on a network port other than loopback; any outbound network call from it.
- Editing contract files (the tag mapping is documented in the dev-log and in a handoff, H-133, and is not a contract change: the schema already forces it); the catalogue; `.github/workflows/**` (the images workflow builds from `infra/images.json`: the sidecar entry of story 2 gains `dockerfile` changes only); terraform; AWS; ssh; docker push; pushes and commits; git checkout, stash or reset; the Excel tracker.
- Claiming live numbers: latency and memory here are local; the `vm-i` numbers are a runbook step.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SQLi | `GET /api/products/search?q=' UNION SELECT 1,2,3,4--` | `proxy.crs_match` with tag `attack_sqli`, rule ids, score above 0; the response to the player unchanged | none |
| SSRF | import URL `http://169.254.169.254/latest/user-data` in a body | match with an `attack_ssrf`-style tag if CRS has one (the spike records which tags exist); else none, recorded | none |
| Benign | normal search `q=blue lamp` | no event | none |
| Logic bug | quick refund twice, legacy login brute force | no match (expected); app events carry the milestone | none |
| Detect only | request that would score above the blocking threshold | answered by the shop as usual; the helper's answer has no action; the sidecar never alters the exchange | none |
| Helper down | process killed | sidecar keeps passing traffic and sending flag events; counter `crs_unavailable`; restarted at most 3 times in a minute | alarm line once |
| Helper slow | answer after 300 ms | call abandoned, counted, no event | none |
| Busy | more than 8 calls in flight | extra calls skipped and counted | none |
| Big body | 20 KiB POST | first 8 KiB inspected (`ProcessPartial`) | none |
| Tag map | CRS tag `attack-sqli` | sent as `attack_sqli`; a tag longer than 32 is cut | none |
| No binary | image built without the helper | `--no-crs` behaviour, no error | none |
| Accuracy run | corpus of challenge exploits and benign requests | table written, labelled local | non-zero exit on a corpus format error only |

</frozen-after-approval>

## Code Map

- `services/sidecar/` (story 2) -- `src/crs.mjs` (new: spawn, health, call with timeout, in-flight cap, tag mapping, the `inspectRequest` hook), `Dockerfile` (add the Go builder stage and the copy of `/app/crs-detect`), `test/crs.test.mjs` (new; the helper is faked by a tiny Node HTTP server for the unit tests).
- `services/sidecar/crs/` (new Go module): `main.go` (about 150 lines: Coraza WAF from directives, `/inspect` handler, loopback listener, counters on `/healthz`), `go.mod`, `go.sum`, `directives.conf` (the `DetectionOnly` settings above, then `Include @crs-setup.conf.example` and `Include @owasp_crs/*.conf` through the embedded file system of `coraza-coreruleset`), `corpus.json`, `crs_test.go` (run in Docker: `docker run --rm -v "${PWD}/services/sidecar/crs:/src" -w /src golang:<pinned> go test ./...`).
- `contracts/events/instance-events.schema.json:928-931` (`class` pattern), `:1000-1034` (`data_proxy_crs_match`) and `contracts/events/app-events.md:162` -- the event the helper's answer becomes; read only.
- `docs/prd/PRD.md:733-738` (FR-DET-02), `:767-771` (FR-DET-07), `:1651` (R-6), `:1676` (S-6), `:1729` (OI-35, CRS tag names beyond `attack-sqli` and `attack-ssrf`) -- the requirements and the open item the spike answers.
- `contracts/instance/examples/valid/instance-template/shop-template.json:106-134` -- the sidecar component limits (256 MB, 0.5 CPU, pids 128): the helper must fit inside them.
- `scripts/crs-accuracy.mjs` (new) and `scripts/crs-accuracy.test.mjs` (new: corpus validation and output format, with a fake helper).
- `docs/adr/` -- an ADR for D-70 is written by the main session (do not create it here); research sources to cite: Coraza (coraza.io), `corazawaf/coraza` and `corazawaf/coraza-coreruleset` releases and licences, OWASP CRS v4 release notes, `corazawaf/coraza-caddy` repository status (R-6), distroless images.
- Docs: dev-log, CHANGELOG, traceability (FR-DET-02, 07, S-6, S-7, OI-35, R-6), HANDOFFS (H-76 answered, row H-133 below), `docs/assets/story-6-5-coraza/`.

## Tasks & Acceptance

**Execution:**
- [ ] `services/sidecar/crs/` -- Go helper, directives, `/inspect`, `/healthz`, Go tests run in Docker
- [ ] `services/sidecar/src/crs.mjs` -- supervisor, call path off the response path, tag mapping; unit tests with a fake helper; never-block tests extended (helper down, slow, busy)
- [ ] `Dockerfile` -- builder stage, copy, image size and resident memory recorded
- [ ] `scripts/crs-accuracy.mjs` and the corpus -- run locally; the S-6 table; the tag names found (answers OI-35's CRS part)
- [ ] a run in the harness of story 2: an SQLi request through the player port shows `proxy.crs_match` in the fake ingest and the response unchanged
- [ ] decision text for the main session: the S-7 comparison (Caddy plugin, Go program, Node plus helper) with sources and the measured numbers

**Acceptance Criteria:**
- Given the SQLi sample, then a valid `proxy.crs_match` with the `attack_sqli` tag reaches the fake ingest and the player's response is byte-identical to a run without the helper.
- Given the helper killed or slow, then traffic and flag events continue.
- Given the corpus, then the S-6 table names which challenge exploits CRS sees, the tags, the false-positive rate on benign traffic, p95 latency and memory, labelled local.
- Given `grep` over the repository, then `SecRuleEngine On` appears nowhere.
- Given the image, then it starts under the runtime profile and stays inside 256 MB with the helper loaded, or the shortfall is recorded with the fallback in force.

## Verification

**Commands (Windows dev PC, Docker Desktop running):**
- `node --test services/sidecar/test scripts/crs-accuracy.test.mjs` -- expected: pass
- `docker run --rm -v "${PWD}/services/sidecar/crs:/src" -w /src golang:<pinned-version> go test ./...` -- expected: pass (the pinned tag and digest recorded in the dev-log)
- `docker build -f services/sidecar/Dockerfile -t vulnmart-sidecar:local services/sidecar` and `docker image inspect vulnmart-sidecar:local --format "{{.Size}}"` -- expected: builds; size recorded
- `node scripts/crs-accuracy.mjs --image vulnmart-sidecar:local` -- expected: table written to `docs/assets/story-6-5-coraza/s6-accuracy.md`
- `node scripts/scan-flags.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

**Local only / developer runbook:** latency, memory and false positives on `vm-i` under real shop traffic, and whether 256 MB holds with CRS loaded there, are runbook steps in `docs/runbooks/detection-live-check.md` (story 4); the developer decides the final accuracy acceptance (`classifier_accuracy_verified`).

## Proposed (decided on the developer's delegation)

- **D-70 Sidecar form (S-7).** Node sidecar plus a small Go helper embedding Coraza and CRS, loopback only, off the response path. Compared: Caddy plugin (maintenance risk R-6, flag matching and signing would still be needed in Go); full Go program (one static binary and a small distroless image, but about two days of work to reproduce the tested stub behaviour, and no Go on the dev PC); Node alone (no usable Coraza for Node). Free licences: Coraza Apache-2.0, CRS Apache-2.0, distroless Apache-2.0.
- **Tag mapping (part of D-70).** The CRS tag `attack-sqli` is sent as `attack_sqli` because the schema allows only `[a-z0-9_]`; told to Sahil and Akshay in H-133.

## Open (not settled here)

- Whether CRS v4.30.0 exists as a published module version and whether 256 MB holds with CRS loaded: the spike answers both; the fallback (`--no-crs`, app events only) keeps the demo working. Risk for the 19th: highest of the five stories (Go build and CRS memory are unmeasured); it is last in the order so it cannot block the loop.
- CRS may not catch a URL in a JSON body at paranoia level 1 (OI-35, unverified): C10 relies on `importer.fetch_attempt` and `meta.request_served` whatever the spike finds.

## Follow-up 2026-10-17
The full compose harness now runs with the product sidecar image (HARNESS_PRODUCT_SIDECAR=1): conformance PASS (23 rules), harness PASS; dev-log 2026-10-17-tannmayygupta-story-6-5-harness-product-sidecar.md.
