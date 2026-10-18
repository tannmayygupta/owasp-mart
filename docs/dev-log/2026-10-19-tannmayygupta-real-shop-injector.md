# The real shop in the lab: the missing injector, the instance wiring and the live proof

Developer: tannmayygupta (stream L, across the boundary to stream T; see handoff H-350). Date: 2026-10-19. Branch: l-real-shop-injector.

## Requirements covered
FR-INS-01, FR-INS-02, FR-FLG-03, FR-FLG-04, FR-SHP-12, NFR-ISO-01; IF-6 section 5; tasks L-13, L-19, L-30 (partly), T-32 (unblocks); epic-production-readiness story 4.

## Summary (plain language, 3-5 lines)
The lab ran only the stub shop, because nobody had built the real injector (the one-shot that plants this instance's flags into the shop before it starts) and because the real shop was never switched to its vulnerable build inside an instance. Both are built now. An instance made by the orchestrator on vm-i is the real shop, ready in about 6 seconds, exploitable in exactly the challenges whose flag was planted; the deployed journey passes 30 of 30 on it.

## Why
Without it a learner could not hack the real VulnMart shop at all, and Sahil's T-32 (all 11 exploit tests on the instance VM) could not start. Handoff H-26 (build the shop image's `inject` entrypoint) had been open since 2026-10-10 with no task owning it.

## What was built
- `apps/shop/src/instance/inject.mjs`: the injector (document rules of the contract schema plus the semantic rules, 64 KiB limit, strict UTF-8, exit codes 10 to 13, one fixed output line, the marker last). `read-document.mjs` is the stub injector's stdin reader, copied verbatim and tested for identical answers.
- `apps/shop/src/instance/placements.mjs`: where each flag goes (database rows, sentinel rows, the weak password of C09, files for C06 and C10), the same set-up the exploit self-tests make by hand.
- `apps/shop/Dockerfile`: the seeded snapshot is built into the image (migrations and seed are copied into the build stage, `seed/build-snapshot.mjs` runs there), so the injector needs no migrations and no password hashing for the base data.
- `apps/shop/src/instance/instance.mjs` `makeInstanceChallenges`, `server.mjs`, `app.mjs`: in an instance a challenge is `vulnerable` exactly when its flag is in the flags file (C03 turns on both of its parts), otherwise the correct build; C03's catalogue uses the instance flag (`flagOf`).
- Deployment: `scripts/live-deploy.mjs` builds and ships `vulnmart-shop:local` (apps/shop context), the `shop` and `injector` roles use it, the injector runs `/app/src/instance/inject.mjs`, the shop has a readiness health check, the demo template sizes the injector at 128 MB (832 MB an instance, 6 instances at the 5600 MB capacity).
- `scripts/e2e-live.mjs`: reads the flag off the real shop through its C05 diagnostics page when the stub route is absent.

## How it works
The orchestrator creates the volumes, runs the injector with the document on standard input (no network, read-only root, no capabilities), waits for exit 0, then starts the shop, which becomes ready only after the marker. The shop opens the snapshot the injector made and treats exactly the planted challenges as exploitable. The sidecar sees a flag in a response to the owning player and the platform credits it.

## Files changed
apps/shop/{Dockerfile,src/app.mjs,src/server.mjs,src/instance/*}, apps/shop/test/instance/inject.test.mjs, scripts/{live-deploy,e2e-live}.mjs and tests, docs/runbooks/live-deploy.md, docs/dev/HANDOFFS.md, docs/audit and docs/dev/dev1-tanmay.md.

## Decisions made
No new ADR. The rule "exploitable exactly when its flag is planted" avoids a contract change (the template allows only the listed environment names); handoff H-350 asks Sahil to confirm or choose an environment name.

## Tests
- `apps/shop` suite 168 passed (34 new): document rules (18 bad documents, each exit 10 and nothing written), exit codes 11, 12, 13, file modes and order, planted rows, parity of the stdin reader with the stub's, and the exploits of C01, C02, C03, C04, C05, C07, C08, C09, C11 passing against an instance made by the injector; a challenge without a flag is not exploitable; before the marker nothing is.
- `challenges/tests` (the release gate) 38 passed, unchanged.
- Container proof with the production profile (no network, read-only, cap_drop ALL, 128 MB injector, 192 MB shop, uid 65532): injector exit 0, files `flags.json` 0400, `injected` 0444, `snapshot.db` 0444, placement files 0400 owned by 65532; the shop ready after the marker; the exploits of C01, C02, C03, C04, C05, C08, C09, C11 succeed over HTTP.
- Live (vm-i): deployed journey 30 of 30 on the real shop (`docs/assets/production-readiness/e2e-run11-real-shop.json`), instance ready in 6.1 s from the request; the running shop container is the distroless real shop image with the baked snapshot.
- scripts: live-deploy test 5 passed (the manifest now names the real shop, one image for shop and injector, the injector script, the shop health check); e2e-live test 2 passed.

## Evidence
docs/assets/production-readiness/e2e-run11-real-shop.json.

## Problems met and how they were fixed
C03 is switched by two keys (C03A, C03B), not C03: the first test run failed on it. PowerShell prepends a byte-order mark when piping a document to a container, which the injector rightly refuses: use file redirection in a shell. The Alpine stub image cannot run the host's Docker CLI (probe), unrelated here.

## Security notes (vulnerable parts only)
The shop is deliberately exploitable in an instance; it is reachable only through the gate with a one-time ticket, on an isolated network (probe 18 of 18 on vm-i). The injector has no network and writes only to volumes; flags never go to the output, the environment or a label.

## Limitations and follow-ups
Not proved against the real services: the C06 file placement (import service) and the C10 file placement (mock services); C03 part B (the bot); C07 through the real mailbox. The volume keeper still uses the stub image. T-32 (Sahil) is now possible; the assessment and recruiter parts of L-30 still wait on stream P routes.