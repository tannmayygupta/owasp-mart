---
title: 'Email templates'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: done
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/bmad/initiative-platform/epic-notifications-and-email/story-outbox-queue-worker-and-email-provider-plan.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** The worker can send mail but only one test template exists; the nine email types of FR-NTF-01 have no text, and nothing stops a caller from putting a password, token or address into an email.

**Approach:** One template registry with a strict allow-list of parameters per type, one-line headers, escaped HTML and links checked as plain http(s) URLs; validation at enqueue (in the cause's transaction) and again at render; the single-use link is removed from the outbox row once the mail is sent.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** "continue automatically", branch and pull request per task. Claude's own scoping decision, recorded for the developer to confirm: FR-NTF-04 (in-app warnings and recruiter alerts) is split into its own story (2.3) because its data source does not exist before the live hub and the dashboards; P-10's task line "the warnings show in the app" is therefore NOT met by this story.

**Always:** A mail names its sender; it carries no password, flag or token except the parameter that is its own single-use link; text placed in a header is one line; text placed in HTML is escaped; the link parameters are the only URLs in a mail.

**Never:** No account lookup (P-11), no scheduler, no in-app warning code, no change to the port Protocols of P-05.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Render | each of the nine types with valid parameters | subject, text, HTML, sender named | n/a |
| Forbidden parameter | `password`, `token`, `flag`, `secret`, `email`, `to` | InvalidParams at enqueue; no row | ValueError to the caller |
| Bad link | `javascript:`, no scheme, credentials, spaces, `ftp:` | InvalidParams | same |
| Header injection | company name with CR LF and `Bcc:` | subject and sender name are one line | n/a |
| HTML injection | `<script>` or `"><img onerror>` in a name | escaped in the HTML | n/a |
| Sent | link template delivered | `params.link` becomes `[removed after sending]` | a failed row keeps it for requeue |
| Slipped through | a row with bad parameters but no enqueue check | `failed` with `bad-params`, no provider call | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/notifications/templates.py` -- `TemplateSpec`, the nine specs plus `system.test`, `TemplateRenderer`, `validate_params`, `EMAIL_TYPES`.
- `apps/api/src/vulnmart/notifications/service.py` -- `Rendered.sender_name`, `InvalidParams`, the enqueue `validator`, removal of secret parameters after sending.
- `apps/api/src/vulnmart/notifications/worker.py`, `kernel/services.py` -- the real renderer is the worker default; the outbox port validates at enqueue.
- `apps/api/tests/test_notification_templates.py` -- the tests; `test_notifications.py` -- one flaky test made safe (one worker thread on a shared SQLite connection).

## Tasks & Acceptance

**Execution:**
- [x] Template registry with the nine types, strict parameters, escaping, link and header rules.
- [x] Validation at enqueue; removal of secret parameters after sending; per-mail sender name.
- [x] Tests for every type and every rule; the same mails through the outbox with a fake provider; rendered mail accepted by the real SMTP message builder.
- [ ] Real-stack check (Mailpit) of a verification mail: written once and then withdrawn, because Docker could not be started; NOT run.

**Acceptance Criteria:**
- Given any of the nine types with valid parameters, then text and HTML render, name the sender and show only the given links.
- Given a password, token, flag, secret or address parameter, or a bad link, then enqueue is refused and no row exists.
- Given a sent link mail, then its row no longer holds the link.

## Implementation Notes

- The outbox row held the raw single-use link until sent, against the spirit of "invite tokens are stored as hashes" (FR-ASM-02): removed at `sent`. While the row is `pending` or `failed` the link is in the database; encrypting it with the KeyPort (P-17) is a follow-up (`deferred-work.md`).
- The deletion mails (three types) follow FR-PRV-08 and FR-PRV-09 as written; P-25 may change their parameters.

## Plan Change Log

- 2026-10-17: FR-NTF-04 split out as story 2.3 (see Decisions).

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. 1 medium, 1 low; both patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A raw single-use link stayed in `email_outbox.params` after the mail was sent | medium | patch | removed at `sent`; tests; the pending-row window is deferred |
| 2 | A P-09 test shared one SQLite connection between Dramatiq threads and failed once in a full run | low | patch | one worker thread; 5 repeated runs passed |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` -- expected: pass (Postgres tests skip without Docker)
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
