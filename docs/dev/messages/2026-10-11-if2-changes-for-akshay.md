# IF-2 (Lab API) changes for Akshay, 2026-10-11
Contract 0.2.0, a proposal for you to confirm. Details: `contracts/api/lab/lab-api.md`, `contracts/CHANGELOG.md`.
1. Errors are RFC 9457 problem details (`application/problem+json`): `type`, `title`, `status`, `detail`, `instance`, plus `code`, `request_id`, `field`. `message` is gone (use `detail`). Codes are lower case with underscores (`att_not_found`). Ignore members you do not know.
2. Timeline paging uses an opaque cursor, not an offset. Send `next_cursor` back as it came. It never goes back: to see late events, re-read from the start (no `cursor`).
3. Every list has `has_more`. Evidence and integrity flags take `limit` (default and maximum 100), the timeline 1 to 200 (default 50). A larger `limit` is 422.
4. Flag answers are only `correct` or `incorrect` (no decoy, other instance or old epoch). Every incorrect try counts for the rate limit (429, `Retry-After`).
5. The owner of a learner attempt no longer sees decoy or sharing integrity flags. Recruiters still do.
6. New 410 `att_gone` (proposal): derived reads of a withdrawn or cancelled attempt. `getAttempt` still shows the state. A deleted attempt is 404.
7. A body that is not JSON is 415 even for an id that does not exist.
8. The role table (who may call what) is in section 1 of `lab-api.md`. Admin has no IF-2 route: please confirm.
Adapt: the error parser, the timeline loop, flag result labels, `has_more`, and a "no longer available" view for 410.