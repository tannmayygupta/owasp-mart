# Harness with the product sidecar, and the confirmed decisions (story 6.5 follow-up)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done locally |
| Report tag | detection, harness |

## Requirements covered
FR-DET-01; decisions D-80 (OI-22), D-92 (OI-38), D-93 (OI-26).

## Summary
The compose harness could not run the product sidecar image (the 6.2 and 6.5 stories noted this). `scripts/harness.mjs` now adds `infra/compose/harness.sidecar.yaml` when `HARNESS_PRODUCT_SIDECAR=1`. The product sidecar also reports flag sightings and requests, so the two event checks count only the `shop.catalog_query_error` event in that mode; the stub mode keeps the strict one-event check. The developer also answered OI-22, OI-26, OI-38 and the H-343 option; they are recorded in `initial.md` (D-80, D-92, D-93) and the handoffs.

## Tests
- `HARNESS_PRODUCT_SIDECAR=1 node scripts/dev.mjs harness`: first run failed two checks (`live-event-stored-and-verified`, `live-event-error-answers`: ingest held 3 events); after the checks were adapted: `conformance: PASS (23 rules)`, `harness: PASS`.
- `node scripts/dev.mjs harness` (stub, default): `conformance: PASS (23 rules)`, `harness: PASS`.
- `node --test scripts/harness.test.mjs`: 19 passed.
- No harness containers or networks were left (`docker ps -a --filter label=com.docker.compose.project=vulnmart-harness` empty).

## Problems met and how they were fixed
The first product run failed on the one-event assumption of the stub. One run in the same command timed out at Docker (transient; the rerun passed).

## Limitations and follow-ups
Local Docker Desktop only. Nothing ran on vm-i.