# 0097. Reading dead admin settings, the FR-ACH-01 hard cap, and an admin route for a silently escalated deletion request

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Claude, under the leader's standing authority (D-104)
- **Requirements:** FR-ACH-01, A-10, A-19, L-11, FR-PRV-08, FR-PRV-09, C02 (FR-CHL-03)

## Context
The 2026-10-21 wiring and role-scenario audits (`docs/audit/2026-10-21-scenario-matrix.md` rows A-10, L-11, A-19) listed four admin settings that are stored and admin-editable (`admin/ops.py::RANGES`, `admin/ops.py::settings`) but read by no code — `instance_idle_minutes`, `instance_max_minutes`, `hints_enabled_default`, `flag_submit_per_minute` — plus the FR-ACH-01 30-per-assessment hard cap (only the 5-per-10-minutes window existed), plus A-19: an escalated candidate deletion request (the company missed `deletion_decide_days`) reaches no admin decision route, only an audit entry (`deletion.escalated`) and a mail. Separately, a tester reported C02 (Cryptographic Failures) as unsolvable ("purana redeem card dhundo but voh exist ni krta" — a redeem code that should work does not).

## Options considered (per item)

**FR-ACH-01 hard cap — a new error code vs. reusing `FlagRateLimited`:**
1. A new IF-8 error code for "assessment-wide cap reached" — precise wording for the learner, but needs a contract version bump, an OpenAPI change, and client-side handling for a code nobody has seen yet.
2. Reuse `FlagRateLimited`/`ATT-FLAG-RATE-LIMITED` with a long `retry_after` (24h) standing in for "not again this assessment" — no contract change, the client's existing 429 handling already covers it, at the cost of a slightly imprecise retry-after semantic.
Chosen: (2). The existing rate-limit UI already explains "try again later"; a 24-hour wait reads the same as "not in this assessment" to a candidate, and a dedicated code is a reasonable but non-urgent follow-up once the dashboards want to show the two cases differently.

**`instance_idle_minutes`/`instance_max_minutes`/`flag_submit_per_minute` — live read vs. bake-in-at-boot:**
1. Have `build_lab_runtime` read the setting once at process start and pass it as a fixed `Limits`/`Rules` default — simplest, but an admin's change would need an API restart to take effect, which is not what the settings API implies.
2. Read the setting fresh for every new instance/attempt (`LabRuntime._base_limits`, `_rules_for`), via the same `DbSettingsPort` the lab's own engine already uses — the admin's change takes effect for the *next* instance with no restart; an already-running instance keeps the limits it was created with (consistent with how `Rules` already works for a candidate's template settings).
Chosen: (2), matching the existing pattern for `session_idle_minutes` and the instance quota settings, which are already read live.

**`hints_enabled_default` — wire now vs. defer:**
`hints_enabled(rec)` in `lab/api.py` always gives a learner hints (`rec.org_id is None or rec.rules.hints_mode == "on"`) regardless of the setting, because `_rules_for` never sets `hints_mode` for a learner. Wiring it needs either a live per-request settings read at every `hints_enabled` call site (risks hints flipping mid-run, a jarring UX change) or changing `_rules_for` to bake `hints_mode` in at attempt creation and changing `hints_enabled` to read `rec.rules.hints_mode == "on"` uniformly for both learner and candidate — which breaks any test or code path that builds a learner `AttemptRecord`/`Rules` directly (bypassing `_rules_for`) and currently relies on the `org_id is None` short-circuit. Decided to defer with this reasoning recorded rather than risk a broad regression in this change; the next action is a dedicated audit of every `AttemptRecord`/`Rules` construction path in the test suite before this is safe.

**A-19 — admin decides vs. leaving escalation as audit-only:**
1. Leave it as an audit entry and a mail (status quo) — the request stays `pending` forever unless the company eventually acts, which defeats the point of an escalation.
2. Give the admin a route that mirrors the company's own `decide` (approve starts the usual 7-day hold, decline ends it), matched by request id alone since an admin has no `org_id` of their own to scope by, and only once the request is actually escalated (`escalated_at IS NOT NULL`) so a silent-but-not-yet-due request stays the company's to decide.
Chosen: (2), following the GDPR-style principle that a data-subject request must reach a decision rather than wait indefinitely on a non-responsive controller; `migration 0015` already grants the application role `UPDATE` on exactly the columns this needs (`status`, `decided_at`, `execute_after`, `finished_at`), so no migration was needed.

**C02 — root cause:**
`WELLFORMED = /^VM-[0-9a-f]{12}$/` only matched lowercase hex and the comparison was case-sensitive; a correctly-forged code in uppercase (as many online MD5 tools print) was rejected as "malformed code" (400), indistinguishable to a confused learner from "this exploit doesn't work." Fixed by normalising the submitted code (case-insensitive match, canonicalised to lowercase) before validation and lookup — this is a defect fix, not a design decision, but is recorded here for the research/evidence trail the leader asked for.

## Decision
Implement all of the above except `hints_enabled_default`, which is deliberately deferred with the reasoning above recorded as the blocker and "audit every `AttemptRecord`/`Rules` construction path first" as the next action.

## Consequences
- An admin changing `instance_idle_minutes`, `instance_max_minutes` or `flag_submit_per_minute` takes effect for the next instance/attempt without a restart; this matches the existing mental model of "the admin settings page changes behaviour," closing a real gap where the settings page lied about what it controlled.
- FR-ACH-01's hard cap closes an anti-cheat gap (a candidate could otherwise brute-force one challenge indefinitely across 10-minute windows); the 24-hour reuse of the existing error code is a deliberate shortcut that should get its own code if the two cases ever need different candidate-facing wording.
- A-19 closes a real GDPR-style risk: a candidate's erasure request could previously stall forever on an unresponsive company with no path to resolution.
- `hints_enabled_default` remains a known, documented gap, not a silently dropped one.

## Evidence
- OWASP ASVS 5.0 (rate limiting / anti-automation controls, relevant to FR-ACH-01's hard cap) and the GDPR Article 12(3)/17 principle that an erasure request must reach a decision within a bounded time (the basis for A-19's "someone must decide, even if the controller does not").
- `apps/api/tests/test_flags_submit.py`, `test_lab_pg.py`, `test_lab_runtime.py` — 242 passed together with real Postgres (`VULNMART_TEST_POSTGRES_DSN`/`VULNMART_TEST_APP_DSN` set), 0 skipped, 2026-10-23.
- `apps/api/tests/test_deletion.py`, `test_deletion_postgres.py`, `test_admin_ops.py`, `test_admin_api.py` — 242 passed together (same run), including a real-Postgres proof that the application role's existing column grants (migration 0015) cover the admin's decision.
- Live reproduction of the C02 bug and its fix against the deployed instance (`tanmay-platform-prod.duckdns.org`), 2026-10-23 (see the dev-log; no flag value recorded per the documentation rule).
