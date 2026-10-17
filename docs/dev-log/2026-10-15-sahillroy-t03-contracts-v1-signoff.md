# Contracts v1.0.0 sign-off + bring Sprint 2 instance work to main (T-03 follow-up)

| Field | Value |
|---|---|
| Date | 2026-10-15 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done (Docker-dependent re-verify pending) |
| Report tag | Target stream, contracts v1.0.0 sign-off (H-121) + Sprint 2 to main |

## Requirements covered
H-121 / T-03: stream-T sign-off of the contracts for the `contracts-v1.0.0` tag (IF-4, IF-6 consumer; IF-7 owner; DB consumer), and bringing the Sprint 2 instance work (T-09–T-13) toward `main` so the real orchestrator and the demo can use the shop and service images.

## Summary (plain language, 3-5 lines)
Merged `origin/main` (Tanmay's contracts v1.0.0 + the real orchestrator, PR #15) into `sprint-2-sahil`, resolving the two CHANGELOG conflicts as unions. Re-read the current IF-4, IF-6, IF-7 and DB against the built shop and catalogue, then signed off the four stream-T Approvals rows in `contracts/COMPAT.md` at 1.0.0, answered H-121 and ticked the "Done checklist" rows the built shop/services answer. Added the shop and the three service roles to `infra/images.json` so CI builds them for the demo/deploy. The Sprint-2 PR is the vehicle that brings T-09–T-16 to `main`.

## Why
The `contracts-v1.0.0` tag waits on each stream's sign-off (H-80/H-120/H-121); the real orchestrator (L-13) and `scripts/dev.mjs demo` need the shop, mock-services, import-service and bot images listed in the build pipeline.

## What was done
- Merged `origin/main` into `sprint-2-sahil` (unions in `CHANGELOG.md` and `contracts/CHANGELOG.md`; traceability, HANDOFFS, dev3-sahil auto-merged).
- **Sign-off (Job 1):** set the four `@sahillroy` rows in `contracts/COMPAT.md` Approvals (IF-4 consumer, IF-6 consumer, IF-7 owner, DB consumer) to `approved`, 1.0.0, 2026-10-15 (keeping the no-outer-pipe table form the base checker needs); answered H-121; ticked checklist rows H-24, H-27, H-29, H-30, H-35, H-36, H-41; added the `registry change:` line for the COMPAT edit.
- **Images (Job 2):** added `shop`, `mock-services`, `import-service`, `bot-controller` to `infra/images.json` (H-118 format, amd64, public — they hold no secrets).

## Contract review (the v1.0.0 changes against my shop)
- **IF-4 (consumer):** 1.0.0 is a label-only release; 0.3.0 moved the **ingest's** error answers to the closed IF-8 body — but the posted schema and the sidecar's `/v1/events` answers (the only ones the shop sees) are explicitly **unchanged**, so the shop is unaffected. The shop posts unsigned with `source: shop`, no `instance_id/epoch/seq`, ≤4 KiB, handling 503 best-effort — all unchanged. **Fits the shop.**
- **IF-6 (consumer):** 0.3.1/0.3.2/1.0.0 are editorial; the template schema, `user 65532:65532`, env patterns and limits are unchanged — the shop and services already conform. **Fits.**
- **IF-7 (owner):** the 11 catalogue stubs validate against the schema at 1.0.0. **Signed.**
- **DB (consumer):** table-owners validated by the rules checker (43 tables, every owner in CODEOWNERS); the shop's tables are covered. **Fits.**

## Evidence
- `node scripts/verify-skills.mjs` → OK (217 files). `node scripts/check-contract-rules.mjs` → **15 PASS, 0 FAIL** (approvals N/A until the tag).
- `node scripts/tag-contracts.mjs --dry-run` → `release-labels` PASS; the `approvals` pending list **no longer contains `@sahillroy`** (only Akshay's and Tanmay's rows remain). `handoffs`/NOT READY as expected (waits on the other streams and on challenge-epic rows).
- `node scripts/images-matrix.mjs` → validates 5 entries (hello + shop + mock-services + import-service + bot-controller).
- `node --test "apps/shop/test/**" "services/*/test/**"` → 110 (109 pass + 1 Windows skip). Exploit runner 6/6. `catalog:check` OK. `check-text-files` + `scan-secrets` PASS.

## Checklist rows left open (deliberate)
The remaining Sahil rows (H-25/26/28/31/32/34/37-40/42-55) stay open: the per-challenge event names/data fields (H-43–H-55) are challenge-epic work; the injector-side (H-26) and S-4/S-5-gated (H-31) rows are not the shop's. Recorded in the H-121 answer.

## Problems met and how they were fixed
Docker Desktop was off earlier on 2026-10-15; once restarted, the confirmatory runs completed:
- **Instance harnesses re-run against the merged mocks — all pass:** T-09 shop-instance 9/9, T-10 shop-events 9/9 (incl. the IF-8-body fake-ingest; the negative control still asserts status 401), T-11 mock-services 6/6, T-12 import-service 7/7, T-13 bot 5/5 — **36 checks, 0 FAIL**. So the v1.0.0 contracts fit the shop/services.
- **`node scripts/dev.mjs demo --no-web` — PASSED (165 s):** the real Python orchestrator built an instance from the template with the real `apps/shop` image: `shop-role`, `orchestrator-start`, `client:create-and-ready` (became ready, health healthy), `client:shop-readyz-inside` (HTTP 200), `client:get-has-no-secrets` (0 of 7 found), create-idempotent, destroy, destroy-idempotent and nothing-left-over all PASS. The first demo run had failed only at `platform-stack-up` (the platform compose, Akshay's stack) from a transient concurrent-build contention — the `api` image builds fine standalone (repo-root context), and the re-run passed; not a shop/service defect.

## Security notes (vulnerable parts only)
No code weakness. The image entries are public (code only, no secrets; flags are injected at runtime). The sign-off is a review action.

## Limitations and follow-ups
- Done: the Docker instance harnesses re-ran against the merged mocks (36/36) and `scripts/dev.mjs demo` passed with the real orchestrator + real shop (above) — reported to Tanmay.
- Two items to confirm with Tanmay: whether he wants the `shop` image entry here or adds it himself; and the orchestrator allowlist `healthchecks` entries for my distroless images (no `wget`; the Dockerfiles use node-based HEALTHCHECK).
- The `contracts-v1.0.0` tag waits on Akshay's (H-120) and Tanmay's sign-offs and the remaining checklist rows.
