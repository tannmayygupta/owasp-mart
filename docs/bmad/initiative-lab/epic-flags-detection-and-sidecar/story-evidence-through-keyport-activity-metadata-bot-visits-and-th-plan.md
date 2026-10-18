---
title: 'Evidence through KeyPort, activity metadata, bot visits and the local detection loop'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/04-data-and-state.md', '{project-root}/scripts/demo_client.py']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** With stories 1 to 3 the sidecar reports flags and the engine credits milestones, but the capturing request is not kept (FR-DET-03), activity metadata is not recorded for timing and anti-cheat (FR-DET-08), bot visits are not recorded (FR-DET-09), the "estimated" label rule is not enforced (FR-DET-07) and no run shows the chain working on real containers. The epic's Done-when item 2 (a valid flag in a response to the owning player is credited within the live-update target, a decoy or another instance's flag is not) has no end-to-end proof. Handoffs H-77, H-76.

**Approach:** (1) `apps/api/src/vulnmart/ingest/evidence.py`: when `proxy.flag_seen` and `evidence.capture` of the same `request_ref` are both seen and the flag was credited (or held), seal the capture body with `KeyPort.encrypt(attempt_id, body, aad)` and store the sealed bytes plus metadata; a capture that is never credited is dropped. A reader class gives `evidence(attempt_id)` and `evidence_body(...)` in the shape of `ReportPort` (`ports/reports.py:76-83`). (2) `ingest/activity.py`: minute buckets of `proxy.request` and `proxy.crs_match` counts (no bodies), a `last_activity` value, and the label rule. (3) `ingest/bots.py`: the record of bot visits, never credited as player captures. (4) A local loop `scripts/detect_loop.py`, built on the structure of `scripts/demo_client.py`: material from story 1, a real create with the orchestrator on Docker Desktop (stub images as shop and injector, the product sidecar from story 2), the fake ingest attached to the instance network for the relay, a request that returns the planted flag, the stored events read back and fed to the engine of story 3. (5) A runbook for the live steps. Decided on the developer's delegation: D-77 (evidence), D-78 (local versus live proof and the label rule). Proposed; the main session records them.

## Boundaries & Constraints

**Always:**
- **Evidence (FR-DET-03, D-22, D-25):** only the request that captured a credited flag is stored. Body at most 8 KiB (the sidecar enforces it; the recorder re-checks and refuses more), `Authorization`, cookie and password fields redacted by the sidecar and again on arrival (a second pass over the body and the header map, defence in depth), flag-like strings already replaced by `[FLAG-REDACTED]` (a final check refuses and alarms if a flag pattern is still there: the event is stored as held with an empty body and an integrity flag of type `activity`, never silently). Sealing: `aad = instance_id | epoch | challenge_key | request_ref`; the stored row is `(evidence_id, attempt_id, challenge_key, captured_at, size, Sealed)`; the plaintext is never kept after sealing. A shredded or missing attempt key (`KeyShredded`, `AttemptNotFound`) drops the capture and counts it; it never writes plaintext as a fallback.
- **Pairing:** `proxy.flag_seen` and `evidence.capture` share `request_ref`; either may arrive first. A pending map holds each half for 60 s (platform time, injected clock). The pair is sealed when the flag was credited or held by the engine; an uncredited, stale, decoy or foreign sighting drops its capture. A late capture for an already credited flag still attaches (up to 300 s).
- **Reader:** `EvidenceReader.evidence(attempt_id)` returns `EvidenceItem`s oldest first; `evidence_body(attempt_id, evidence_id)` decrypts through KeyPort and raises the same errors as `ReportPort` (`AttemptNotFound` for another attempt's id, `AttemptGone` after shred). It is the data source of the real `ReportPort` (a later story wires it).
- **Activity (FR-DET-08):** buckets keyed `(instance_id, epoch, minute)` hold counts only: requests, per status class, per method class, `crs_match` per tag, distinct route templates; no body, no query, no user text, UTC. `last_activity(instance_id)` returns the latest bucket time; it is the input for the orchestrator's idle rule (H-122: the activity signal to the orchestrator is still open; this story only offers the value).
- **Label honesty (FR-DET-07, D-78):** a function `attribution_label(settings)` returns `"estimated"` unless the setting `classifier_accuracy_verified` is true (it is false until story 5's measurement is accepted by the developer); `per_challenge_time_allowed(settings)` is false until then (assessment-level only, FR-DET-07 AC). Both are tested; neither changes a score.
- **Bots (FR-DET-09):** `bot.visit` events (source `bot`, session_kind `bot`) are recorded as `(instance_id, epoch, visit_id, ticket_id, phase, at)` and counted; `collector.hit` credits only through the C03 rule of story 3 (`bot_tagged`); a stored-XSS capture by the player's own browser or any non-bot-tagged hit credits nothing; a test mixes bot and player events and asserts that no `session_kind` bot event ever credits a milestone or becomes evidence of a player capture.
- **Local loop `scripts/detect_loop.py`:** Python, runs from the repo root with `uv run --locked --package vulnmart-orchestrator python scripts/detect_loop.py`; reuses `scripts/demo_client.py` helpers where they fit (`docker`, `leftovers`, `wait_state`, `make_request`) and the orchestrator test support for a real-Docker engine with `allow_local_ids=True`; builds the stub image (`vulnmart-stub-instance:local`) and the sidecar image (`vulnmart-sidecar:local`) if missing; creates one instance with the material of story 1 (two challenges, one decoy each); starts a fake ingest container (stub image, command `ingest`) with the same event key and attaches it to the instance network with alias `edge`; requests `/_stub/planted-flag?key=C05` (the stub shop's test route that returns the injected flag) through the sidecar's player port by `docker exec` of node inside the sidecar container; requests a decoy value and a flag-shaped foreign value the same way; reads the stored events back; replays them through the engine; asserts M3 for C05 within 10 s, no credit for the decoy, a `foreign` sighting for the foreign value, a sealed evidence row whose body decrypts and holds no flag, and a second instance of the same template with different flags; destroys everything and asserts no objects are left; prints PASS or FAIL per step, with no flag, key or digest in the output (a final scan of its own output and of the container logs with `scripts/scan-flags.mjs`).
- The fake ingest gets one additive test-only route `GET /_fake/events/full` (the stored wire events, ordered by `(epoch, seq)`) in `contracts/mocks/fake-ingest/server.mjs`, with a test; it is a mock of stream L, not a contract file, and is marked "not part of IF-4" like its neighbours.
- The loop and the live runbook state plainly which numbers are local Docker Desktop and which are live; nothing in the dev-log says live passed.

**Never:**
- Storing a request body other than the credited capture; storing a response body; storing any flag, digest or candidate; keeping plaintext after sealing; a fallback that writes plaintext when the key is missing.
- Editing contract files, the catalogue, the orchestrator, `apps/api/pyproject.toml`, migrations, Akshay's non-port code, `.github/workflows/**`, terraform; AWS; ssh; docker push; pushes and commits; git checkout, stash or reset; the Excel tracker.
- Claiming a live result: the vm-i and vm-p runs are steps for the developer in the runbook.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Credited capture | flag credited, capture with the same `request_ref` | one sealed row; metadata readable; body decrypts to the redacted request | none |
| Capture first | capture arrives before the flag sighting | held up to 60 s, sealed when the credit happens | dropped after the TTL if never credited |
| Decoy capture | sighting is a decoy | no evidence stored | none |
| Over 8 KiB | body of 9000 bytes | refused, counted, integrity flag `activity` | none |
| Flag still in body | pattern present | stored as held with empty body, integrity flag | alarm count |
| Shredded key | `KeyShredded` | dropped, counted, no plaintext | none |
| Read | evidence of another attempt's id | `AttemptNotFound` | none |
| Activity | 30 `proxy.request` in a minute | one bucket with counts; no body fields | none |
| Label | `classifier_accuracy_verified` false | `estimated`; per-challenge time not allowed | none |
| Bot | `bot.visit` and a `shop.*` event with session bot | visit recorded; nothing credited | none |
| Bot-tagged hit | `collector.hit` bot_tagged true | C03 M2 by the story 3 rule | none |
| Loop happy | real create, planted flag requested through the sidecar | PASS: M3, sealed evidence, decoy and foreign not credited, nothing left | non-zero exit and cleanup on failure |
| Docker missing | no daemon | loop prints SKIP and exits 0; real-Docker tests skip | none |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/ports/reports.py:48-56` (`EvidenceItem`), `:76-83` (`ReportPort.evidence`, `evidence_body`), `ports/keys.py:79-111` (`Sealed`, `encrypt`, `decrypt`, `shred`), `ports/fakes.py:148-171` (`FakeKeyPort.encrypt/decrypt/shred`), `ports/errors.py` (`KeyShredded`, `AttemptNotFound`, `AttemptGone`) -- the types and errors the recorder and reader use.
- `apps/api/src/vulnmart/ingest/` -- new `evidence.py`, `activity.py`, `bots.py`; stores added to `ingest/stores.py` (story 3): `EvidenceStore`, `ActivityStore`, `BotVisitStore` with fakes. Real tables `evidence`, `activity_buckets` (owner `ingest`, `contracts/db/table-owners.yaml:37-39`) are Akshay's migration (H-330).
- `contracts/events/instance-events.schema.json:1106-1134` (`data_evidence_capture`) and `app-events.md:23-26,142-143,196` (caps, redaction, `[FLAG-REDACTED]`) -- read only.
- `contracts/mocks/fake-ingest/server.mjs:62-65` (`/_fake/events`, `/_fake/epoch`) and its test -- add `/_fake/events/full`.
- `scripts/demo_client.py:34-135` (`step`, `new_iid`, `make_request`, `wait_state`, `docker`, `leftovers`, `full`) and `scripts/demo.mjs` -- the structure and helpers the loop reuses; `apps/orchestrator/tests/test_docker_integration.py:22,54,102` (stub image build, allowlist with local ids, commands per role) -- how a real-Docker engine is made.
- `contracts/mocks/stub-instance/shop.mjs:6,87-92` (`/_stub/planted-flag`), `main.mjs:12-51` (`ingest` command), `fixtures.mjs` -- the stub shop that returns its injected flag and the fake ingest entry point.
- `apps/orchestrator/src/vulnmart_orchestrator/builder.py:484-502` (`injection_document`, `sidecar_document`) -- read only: what the real create gives the sidecar.
- `scripts/scan-flags.mjs` (story 1) -- the final scan.
- `docs/runbooks/` -- new numbered section `docs/runbooks/detection-live-check.md` (the live steps: images, a real instance on vm-i, the planted-flag request, the evidence read, the scan).
- Tests: `apps/api/tests/test_ingest_evidence.py`, `test_ingest_activity.py`, `test_ingest_bots.py` (new), `contracts/mocks/fake-ingest` test for the new route, `scripts/detect_loop.test.py` or a pytest in `apps/orchestrator/tests/test_detect_loop.py` for the loop's skip and cleanup paths.
- Docs: dev-log, CHANGELOG, traceability (FR-DET-03, 07, 08, 09, FR-FLG-09, NFR-PRF-03 as local only), HANDOFFS (H-77 closed, H-330 extended for Akshay with the evidence and activity tables), `docs/assets/story-6-4-detection-loop/`.

## Tasks & Acceptance

**Execution:**
- [ ] `ingest/evidence.py` -- pairing, second redaction pass, sealing through KeyPort, reader in `ReportPort` shape
- [ ] `ingest/activity.py`, `ingest/bots.py` -- buckets, `last_activity`, label rules, bot records
- [ ] tests -- every matrix row with `FakeKeyPort`; a test that a second attempt cannot read the first one's evidence; a test that no sealed row or log line holds a flag
- [ ] `fake-ingest` `/_fake/events/full` and test
- [ ] `scripts/detect_loop.py` -- the loop as described; local run, output saved
- [ ] `docs/runbooks/detection-live-check.md` -- numbered live steps and the evidence to save
- [ ] docs and handoff rows as in the Code Map

**Acceptance Criteria:**
- Given a credited flag with its capture, then a sealed row exists, `evidence_body` returns the redacted request, and after `shred` it is unreadable.
- Given a decoy, a stale or foreign sighting or an uncredited capture, then nothing is stored.
- Given the local loop on Docker Desktop, then it prints PASS for: M3 for C05 within 10 seconds of the request, decoy not credited, foreign sighted, evidence sealed and readable, the second instance holds other flags, nothing left, and its output and the container logs hold no flag.
- Given `classifier_accuracy_verified` is false, then labels read `estimated` and per-challenge time is not allowed.
- Given bot events, then none credits a milestone or becomes evidence.

## Verification

**Commands (Windows dev PC with Docker Desktop for the loop):**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ingest_evidence.py apps/api/tests/test_ingest_activity.py apps/api/tests/test_ingest_bots.py` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` and `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"` -- expected: pass
- `docker build -f contracts/mocks/stub-instance/Dockerfile -t vulnmart-stub-instance:local .` then `docker build -f services/sidecar/Dockerfile -t vulnmart-sidecar:local services/sidecar` -- expected: build
- `uv run --locked --package vulnmart-orchestrator python scripts/detect_loop.py` -- expected: PASS lines, exit 0, output saved to `docs/assets/story-6-4-detection-loop/`
- `node scripts/scan-flags.mjs --output docs/assets/story-6-4-detection-loop/loop-output.txt` -- expected: clean
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

**Local only / developer runbook:** the live-update time (NFR-PRF-03) measured here is local Docker Desktop only; the live check on `vm-i` with the real edge relay, real ingest and real shop is `docs/runbooks/detection-live-check.md` (T-32 with Sahil): the developer runs it and records the result.

## Proposed (decided on the developer's delegation)

- **D-77 Evidence.** The sidecar builds the capture; the platform seals it per attempt with `KeyPort.encrypt` (AAD binds instance, epoch, challenge and request) only when the flag was credited or held; everything else is dropped; stores are Protocols with fakes until Akshay's tables exist.
- **D-78 Local versus live proof.** Everything measured on Docker Desktop is labelled local; the live runs are runbook steps for the developer; per-challenge active time is shown as estimated and assessment-level only until the classifier accuracy (S-6, story 5) is verified and the developer accepts it.

## Open (not settled here)

- How instance activity reaches the orchestrator for the idle rule (H-122) and the real route that feeds events from the edge to `process_event` (L-18 and Akshay's ingest endpoint, H-75): this story offers `last_activity` and the recorder; the calls are wired by whoever owns the route.
- The relay inside a real orchestrator instance needs the edge (L-17/L-18); the local loop attaches a fake ingest as `edge` to prove the rest. Risk for the 19th: if L-17/L-18 do not land, the live demo has no event path and the engine has nothing to read; the loop is then the only proof.
