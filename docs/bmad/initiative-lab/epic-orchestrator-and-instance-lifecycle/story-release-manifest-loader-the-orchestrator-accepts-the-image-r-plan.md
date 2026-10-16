---
title: 'Release manifest loader: the orchestrator accepts the image release file with per-role healthchecks'
type: 'feature'
ticket: '7'
created: '2026-10-16'
status: 'draft'
baseline_revision: ''
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `scripts/images-release.mjs` writes `release.json` as `{commit, repo, images, healthchecks}` (the PR of the shop stream adds `healthchecks`), but `ImageAllowlist.from_manifest` refuses the keys `commit` and `repo`, refuses the image `hello` (not an orchestrator role) and passes a healthcheck argv to Docker without `CMD`. So the shop, mock-services, import-service and bot-controller images would never become healthy under the orchestrator (review of PR 14, 2026-10-16).

**Approach:** Add `ImageAllowlist.from_release(data)` for the pipeline's file. It keeps `from_manifest` strict for the orchestrator's own manifest, reads only `images` and `healthchecks` of the release file, skips images that are not orchestrator roles, and turns each role's argv into a Docker `Test` list starting with `CMD`. Decided on the developer's delegation, recorded as D-56 (Proposed).

## Boundaries & Constraints

**Always:** Digests keep their rule (`name@sha256:<64 hex>`; local ids only with the existing `allow_local_ids` flag). A healthcheck is an exec-form argv of non-empty strings, `argv[0]` is an absolute path, never a shell (`sh`, `bash`, `ash`, `dash`), `wget`, `curl` or `nc`, at most 16 items of at most 512 characters. A role in `healthchecks` must also be in `images`. Unknown top-level keys other than `commit` and `repo` are refused. The loader never reads files itself apart from the one it is given. The orchestrator's `--images` option accepts either file form (a key `images` with `commit` or `repo`, or `healthchecks`, selects the release form). Error text names the field, never a value that could be a secret.

**Never:** Changing `scripts/images-release.mjs`, `infra/images.json`, `scripts/images-matrix.mjs` or the Dockerfiles (stream T and the image pipeline own them; a handoff row tells Sahil that the pipeline output is accepted as is and that `CMD` is added here). Touching `contracts/**`, `.github/workflows/**`, the Excel tracker, pushes, commits.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real release | output of `buildRelease` for the five images | allowlist with the four roles and their `CMD` health tests; `hello` skipped | none |
| Extra keys | `commit`, `repo` present | ignored | none |
| Unknown top-level key | `foo` present | refused | ValueError naming the key |
| Not a role | `hello` in images | skipped, not an error | none |
| Healthcheck for a role without an image | `healthchecks.shop`, no `images.shop` | refused | ValueError |
| Shell or wget argv | `["/bin/sh","-c","..."]`, `["wget",...]` | refused | ValueError |
| Bad digest | `images.shop` not a digest | refused (as before) | ValueError |
| Already CMD | argv starts with `CMD` | not doubled | none |
| Strict manifest | `from_manifest` with `commit` | still refused | ValueError |

</frozen-after-approval>

## Code Map

- `apps/orchestrator/src/vulnmart_orchestrator/images.py` -- `ROLES` (:21), `ImageAllowlist`, `from_manifest` (:66) and `load`; add `from_release`, a `_health_test` helper and the argv rules.
- `apps/orchestrator/src/vulnmart_orchestrator/builder.py:447` -- already uses `images.healthchecks.get(role)` as the Docker `Test`; so the list stored by the loader is `("CMD", ...)`. Do not change `_health_test` (template-based fallback).
- `apps/orchestrator/src/vulnmart_orchestrator/__main__.py`/`service.py` -- the `--images` option (find it) picks the loader.
- `apps/orchestrator/tests/test_states_images.py` -- existing allowlist tests (`CMD` at :90); add the matrix tests and one test that runs `node scripts/images-release.mjs` (find its CLI) or builds the same JSON shape inline if the script needs a git or registry state; mark which one ran.
- `docs/dev/HANDOFFS.md` (new row for Sahil, H-118 follow-up), `initial.md` D-56, `CHANGELOG.md`, `docs/traceability.md` (FR-INS-07), dev-log, evidence `docs/assets/story-3-7-release-loader/`.

## Tasks & Acceptance

**Execution:**
- [ ] `images.py` -- `from_release` and the argv rules
- [ ] `service.py`/`__main__.py` -- `--images` picks the loader
- [ ] `test_states_images.py` -- every matrix row
- [ ] docs -- as in the Code Map, story state `built`

**Acceptance Criteria:**
- Given the real output of the release script, when the orchestrator loads it, then the shop role has a health test starting with `CMD` and `/nodejs/bin/node`, and the build of a plan for the shop template uses it (test through `build_plan`).
- Given `from_manifest` as before, its tests still pass unchanged.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests -k "images or release or builder or states"` -- expected: pass
- `node scripts/images-matrix.mjs` -- expected: JSON of the images (read only)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
