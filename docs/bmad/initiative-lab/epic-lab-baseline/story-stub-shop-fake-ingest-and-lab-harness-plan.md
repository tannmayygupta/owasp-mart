---
title: 'Stub shop, fake ingest and lab harness'
type: 'feature'
ticket: '5'
created: '2026-10-10'
status: 'in-progress'
baseline_revision: '32324a541e77561faa2a239ed26455b4f9783472'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Sahil (T-04) and the lab need a reference instance to build against, but no code exists for any instance component: nothing proves the instance contract (IF-6) and the event contract (IF-4) work together.

**Approach:** Build one pinned Node stub image with five commands (`shop`, `inject`, `sidecar`, `edge`, `gate`), a Compose harness that starts one full stub instance with the fake ingest, the command `node scripts/dev.mjs harness`, and a live conformance check, so the done-when of L-06 is proved by a real run.

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-10: stubs are small Node programs with real behaviour where the contract needs it (the stub sidecar validates the posted schema, adds `instance_id` and the next `seq`, signs with the event key and forwards through the edge relay to the fake ingest; edge and gate are pass-through); the entry command is `node scripts/dev.mjs harness`; the stub exists only for tests and is never a product image; the sidecar start input (OI-35, H-59) is one JSON document read once from standard input at start, described by a new schema `contracts/instance/sidecar-start.schema.json` (`schema_version`, `instance_id`, `epoch`, `first_seq` at least 1, `event_key` 32 to 128 characters, `flag_digests`) with examples, checked by `contracts:check`, an additive proposal for Akshay and the L-13 orchestrator; the stub image is built by one local Dockerfile from a Node 24 base pinned by digest, so the harness runs the real runtime profile with no bind mounts. The harness follows the instance runtime profile of IF-6 (user 65532, read-only root, no-new-privileges, cap_drop ALL, no privileged, tmpfs only for `/tmp` and `/data`, the four named memory-backed volumes, no bind mounts, ports published only on 127.0.0.1, injector with `network_mode: none`, start order injector first then the rest, no flag, seed or key in an environment variable, a compose file or an image). Flags, seed and event key are made fresh at each run with obviously fake test values and are never written to a tracked file, a log or a doc. Images are pinned by digest; actions in CI stay pinned by SHA. The stub meets IF-6 section 3 (`/healthz`, `/readyz` only after marker and open DB, `/version`) and IF-4 section 3 (POST to `/v1/events`, under 4 KiB, valid against the posted schema). Real commands and results only; every fix has a test that fails before it.

**Never:** No real Caddy edge, real gate, real sidecar behaviour beyond the above, real injector, real shop, orchestrator or image build pipeline (L-12, L-13, L-15, L-20, T-04, T-08 own those). No change to IF-1, IF-2 or IF-5. No new decision on OPEN items other than the sidecar start input (OI-35, H-59), which is defined here only as a proposal the developer confirms below. No secrets in the repository. No push, no pull request. No weakening of any contract rule to make the stub pass.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full run | `node scripts/dev.mjs harness` on a clean machine | stack starts, conformance passes, prints PASS, exit 0 | any failed step: names it, exit 1 |
| Before the marker | shop started, no injection yet | `/healthz` 200, `/readyz` 503 | — |
| After the marker | injector exit 0 | `/readyz` 200 within the start period; `/version` has build id, no secret | — |
| Marker without open DB | marker present, DB not open | `/readyz` 503 | — |
| Planted flag | harness fake flag | served by the stub test route, equals the flag in `/run/vm/flags.json`, never in logs | — |
| App event | one `POST` of a posted-schema event | fake ingest stores `(instance_id, seq)`, signature verified, seq as given by `first_seq` | — |
| Event too big or wrong | over 4 KiB, wrong type, bad JSON, a forbidden `source`, GET | 413, 415, 422, 400, 405 as IF-4 | problem body, nothing forwarded |
| Ingest down | edge relay unreachable | sidecar keeps the event and retries until 202 or 200; drops on 401, 409, 413, 422 | bounded buffer |
| Injector exit codes | bad document, unwritable snapshot, placement or flags/marker | exit 10, 11, 12, 13 and nothing printed from the document | marker absent unless all steps passed |
| Injector network | injector tries any connection | none possible (`network_mode: none`) | checked in the resolved compose config |
| Order | shop started before the injector exited | not started by the harness; shop refuses ready | — |
| Contract drift | a harness rule differs from the instance runtime profile (bind mount, writable root, extra capability, published port beyond 127.0.0.1) | the conformance check fails and names the rule | exit 1 |
| Cleanup | `harness down` or a failed run | all containers, networks and volumes of the harness removed | no leftovers |

</frozen-after-approval>

## Code Map

- `contracts/instance/instance-contract.md` s1, s2, s3, s5, s6, s7 and `examples/valid/instance-template/shop-template.json` -- roles, ports, env allowlist, probes, injector steps and exit codes, runtime profile, volumes; schemas `injection-document`, `flags-file`, `instance-template`.
- `contracts/events/app-events.md` s3 to s5, `instance-events.posted.schema.json`, `contracts/mocks/fake-ingest/{server,ingest,sign}.mjs` -- posted body rules, signing HMAC, relay path `/internal/v1/events` on 8081, ingest answers and `GET /_fake/events`; the ingest binds 127.0.0.1 by default (`--host`).
- `infra/compose/compose.yaml` (service `hello`: hardening pattern, digest pin, healthcheck 2s/2s/15), `scripts/dev.mjs` (commands `hello`, `up`, `down`, `doctor`; `PROFILES`, `HELP`, `parseArgs`), `scripts/dev.test.mjs`, `scripts/e2e/dev.e2e.test.mjs` -- extend with `harness`.
- `.github/workflows/ci.yml` job `compose` -- add the harness run; do not change the other jobs.
- `docs/architecture/07-repo-and-workstreams.md` s3.1, line 185 (stub shop = tiny Node app) and 02 (edge, gate, networks `inst-<id>` and `front-<id>`), ADR 0005, 0016, 0017.
- New: `contracts/mocks/stub-instance/` (stub sources, tests, Dockerfile), `scripts/check-instance-conformance.mjs` (live probes plus checks on the resolved compose config through `docker compose config --format json`).
- Handoffs read for this plan (rule 2b): H-74 (stub conformance), H-56 (T-04 uses this as the reference), H-59 (sidecar start input), H-26 to H-28 (injector, snapshot hand-over, placement volumes), H-60 (start order), H-62 (injector network none), H-63, H-64 (flag flow, flags_injected not via sidecar: out of scope here), H-75, H-76 (ingest, edge relay and sidecar behaviour). Answers are written back to the rows.
- Do not touch: other developers' tracker folders, IF-1, IF-2, IF-5 files.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/mocks/stub-instance/` -- `shop` (health, readiness, version, planted-flag test route, event trigger), `inject` (stdin document, snapshot, flags file, marker, exit codes), `sidecar` (9000 events, 8080 pass-through to the shop, signing, seq, retry and drop rules), `edge` (relay 8081 and pass-through), `gate` (always allow); node:test unit tests per command -- the stub instance
- [ ] `contracts/mocks/stub-instance/Dockerfile` and `infra/compose/harness.yaml` (or a profile in `compose.yaml`) -- pinned image, full instance with the fake ingest, networks, volumes, start order, healthchecks, runtime profile -- the harness
- [ ] `contracts/instance/sidecar-start.schema.json`, examples and `instance-contract.md` s6 and open point 35, `contracts/CHANGELOG.md` (decided 2026-10-10) -- the sidecar input
- [ ] `scripts/dev.mjs` (+ tests, e2e) -- `harness` and `harness down`; fresh random fake test values per run
- [ ] `scripts/check-instance-conformance.mjs` (+ tests) -- live probes for the done-when and static checks of the resolved compose config against the runtime profile
- [ ] `.github/workflows/ci.yml` -- run the harness in job `compose`
- [ ] `docs/dev/HANDOFFS.md` -- answer H-74, H-56, H-59, H-26 to H-28, H-60, H-62, H-75, H-76; add a row for Sahil (how to run the harness and what the stub offers) and rows for L-13 and L-20 (sidecar start document)
- [ ] Documentation rule -- dev-log, CHANGELOG, traceability LB-6, ADR for the sidecar input and the stub design, evidence in `docs/assets/l-06-stub-harness/`; tick L-06 only after the developer confirms

**Acceptance Criteria:**
- Given a clean machine with Docker, when `node scripts/dev.mjs harness` runs, then it starts one full stub instance, answers health, becomes ready only after the marker, serves the planted flag, delivers one event that the fake ingest accepts and verifies, passes the conformance check and exits 0.
- Given the resolved compose config, when the conformance check runs, then every runtime-profile rule is checked, and a deliberately broken copy (bind mount, writable root, extra capability, wide port, injector with network) fails with the rule's name.
- Given each matrix error row, when exercised, then the stated answer is returned and no flag, seed or key appears in any log, answer or file.
- Given the harness is stopped or fails, when `harness down` runs, then no container, network or volume of it remains.
- Given CI, when job `compose` runs, then the harness passes on Linux.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Chain: player to edge (127.0.0.1) to gate (allow) to sidecar 8080 to shop 3000. Events: shop to sidecar 9000 at `/v1/events`, then the sidecar signs and posts to the edge relay `:8081/internal/v1/events`, which forwards to the fake ingest. The stub sidecar and the harness receive key, digests and first_seq at start only on standard input; the fake ingest takes the same test key through its `--key` option, which exists only in the harness. The planted flag is served by a clearly marked test route that is not part of IF-6 and exists only so the conformance check can see it.

## Verification

**Commands:**
- `node scripts/dev.mjs harness` -- expected: PASS, exit 0, then `node scripts/dev.mjs harness down` leaves nothing (`docker ps -a`, `docker network ls`, `docker volume ls`)
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"` -- expected: all pass
- `node --test scripts/e2e/dev.e2e.test.mjs` -- expected: all pass
- `pnpm run contracts:check` -- expected: PASS for all four contracts
- `pnpm run ci:linux` -- expected: PASS including the harness
- `git grep -n "VM{" -- contracts/mocks/stub-instance infra` -- expected: no real-looking flag
