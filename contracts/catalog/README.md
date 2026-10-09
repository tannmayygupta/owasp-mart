# Challenge catalogue (IF-7)

The catalogue is the contract that describes the 11 VulnMart challenges to the
platform (dashboards, API) and the lab (scoring, injector). Owner: stream T.

- **Schema:** [`challenge.schema.json`](challenge.schema.json) — one challenge entry, JSON Schema draft 2020-12.
- **Data:** [`../../challenges/catalog/`](../../challenges/catalog/) — one `cNN.yaml` per challenge, `c01`..`c11`.
- **Validator:** `node scripts/validate-catalog.mjs` (or `pnpm run catalog:check`). CI runs it through `scripts/validate-catalog.test.mjs`.

## Status: stubs (v0.1, sprint zero)

Every entry is `status: stub`. A stub carries the OWASP 2021/2025 tags, CWE and
ATT&CK ids, difficulty and tier, placeholder milestone summaries and three empty
hint slots, and the instance-dependent fields (flag placement/delivery,
start-state, exploit-test and fixed-build paths) as provisional values.

Full player briefs, write-ups, decoy flag locations, filled hints and the
official-site re-check of every id are added in **T-30**; each challenge's real
milestone signals and confirmed flag placement come with that challenge's own
story (T-19..T-29). Tags are copied from `docs/design/challenge-specs.md`, which
records each id's verification status.

Tier is derived from difficulty (D-32: 1-2 Easy, 3 Medium, 4-5 Hard) and the
validator enforces the mapping. No real flag value ever appears in the catalogue.
