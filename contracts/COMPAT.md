# Contract compatibility (COMPAT)

Which version of each contract every stream builds against. Read by `node scripts/check-contract-rules.mjs` (check `compat`): the first two columns are
the contract id of `contracts/registry.json` and a version that exists in `contracts/CHANGELOG.md` (or a tag `contracts-vX.Y.Z`); further columns are free.
Each stream adds and maintains its own rows (stream P in story P-08; stream L in L-09; stream T in T-03). The tag `contracts-v1.0.0` is created by L-09.

## Stream P (Akshay), recorded 2026-10-12 (story P-08)

| Contract | Version | Stream | Role | Note |
|---|---|---|---|---|
| IF-1 | 0.1.0 | P | provider | sprint-2 slice |
| IF-2 | 0.2.0 | P | consumer | dashboards; error body moves to IF-8 before v1.0.0 (H-114) |
| IF-3 | 0.1.0 | P | provider | |
| IF-4 | 0.2.0 | P | consumer | key service, event keys |
| IF-5 | 0.3.0 | P | consumer | `InstanceHost` client, state reports; error body moves to IF-8 before v1.0.0 (H-114) |
| IF-6 | 0.2.0 | P | consumer | flag material, owner hash |
| IF-7 | 0.1.0 | P | consumer | catalogue route and sync job |
| IF-8 | 0.3.0 | P | provider | |
| DB | 0.2.0 | P | provider | table owners |

Sign-off review: `docs/reviews/2026-10-12-p08-contract-sign-off.md`.
