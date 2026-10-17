# Release file loader: the orchestrator accepts the image pipeline's file (story 3.7, FR-INS-07)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `1ee5c01` (commit of this story follows) |
| Status | Done: built and tested; the real shop, mock-services, import-service and bot-controller images are not in `main`, so no CI release was loaded |
| Report tag | orchestrator, image release, FR-INS-07, D-56 |

## Requirements covered
FR-INS-07, handoff H-118 (follow-up), H-124 (new), decision D-56 (Proposed). Review of PR 14 (2026-10-16) was the source of the problem.

## Summary (plain language)
The image pipeline writes `release.json` as `{commit, repo, images, healthchecks}`. The orchestrator refused it (unknown keys, the image `hello`, and a health test without `CMD`). It now has a second loader for that file. The strict loader for its own manifest is unchanged.

## Why
Without this the shop, mock-services, import-service and bot-controller images would never become healthy under the orchestrator.

## What was built
`ImageAllowlist.from_release`: reads only `images` and `healthchecks`, ignores `commit` and `repo`, refuses any other top-level key, skips images that are not orchestrator roles, and turns each role's argv into a Docker `Test` list starting with `CMD` (not doubled when already there). `ImageAllowlist.load` (used by `--images-manifest`) picks the loader: `commit` or `repo` present, or `healthchecks` without `entrypoints`/`commands`, means the release form.

## How it works
A health argv must be a list of 1 to 16 non-empty strings of at most 512 characters, `argv[0]` an absolute path whose program is not `sh`, `bash`, `ash`, `dash`, `wget`, `curl` or `nc`. A role in `healthchecks` must have an image. The builder already uses `images.healthchecks[role]` as the Docker `Test`, so it is unchanged. Digest rules are the existing ones.

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/images.py` - `from_release`, argv rules, form detection in `load`
- `apps/orchestrator/tests/test_states_images.py` - one test per row of the matrix, a `build_plan` test, a test through the real `buildRelease`
- `initial.md` (D-56), `docs/dev/HANDOFFS.md` (H-124), `CHANGELOG.md`, `docs/traceability.md`, this log, `docs/assets/story-3-7-release-loader/pytest-output.txt`

## Decisions made
D-56 (Proposed, developer's delegation). No ADR: small extension of the loader of ADR 0032's pipeline. Alternative: change the pipeline script; rejected because stream T and the pipeline own it.

## Tests
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests -k "images or release or builder or states"`: 101 passed.
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 377 passed in 91.86 s.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: both PASS.
- Which release test ran: `test_output_of_the_real_release_script_is_loaded` ran the real `buildRelease` of `scripts/images-release.mjs` through node on five image names, because `infra/images.json` lists only `hello` until the shop PR merges; the `healthchecks` key was added by the test (the shape the shop PR adds). Other release tests use inline JSON of the same shape.
- Traceability: FR-INS-07 row updated.

## Evidence
`docs/assets/story-3-7-release-loader/pytest-output.txt`.

## Problems met and how they were fixed
First run of the real-script test failed: `infra/images.json` has only `hello` here, so no `shop` role. Fixed by giving `buildRelease` its own image list. While editing the docs, a helper function wrote empty files for `CHANGELOG.md` and `docs/traceability.md` (a relative path read through .NET); both were restored with `git checkout` (they had no earlier edits) and redone.

## Security notes (vulnerable parts only)
None: the loader tightens what a health argv may be (no shell or network tools). Error text names the field, never a value.

## Limitations and follow-ups
Not run on a real CI release (images not in `main`). H-124 tells Sahil that no change is needed on his side. `from_manifest` still accepts `healthchecks` with `CMD` as before.