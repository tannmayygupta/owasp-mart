# 0062. Break-glass sessions and the admin's audit log

- **Status:** Proposed (the builder's design for the developer to confirm; D-94 answers OI-12: 15 minutes, the company is alerted too)
- **Date:** 2026-10-20
- **Deciders:** Claude Code (design); the developer (OI-12, OI-34, D-97)
- **Requirements:** FR-ADM-03, FR-ADM-07, FR-ADM-08, FR-PRV-19, FR-PRV-20, D-19, D-94, D-95, D-97, ADR 0057, ADR 0060
- **Numbering:** 0061 is left for the renumbering of the second record 0058 (handoff H-357).

## Context
An admin must never have standing access to a candidate's answers, write-ups or evidence (FR-ADM-08); break-glass is the one way, with a written reason, a time box, a real-time alert, a record of what was read and a later review (FR-ADM-03). Admins read the full audit log, and each read is logged (FR-ADM-07). The architecture planned a table `break_glass_sessions` (architecture 04, owner admin).

## Options considered
1. **Where the content is read:** open the lab's reviewer routes to an admin with a grant / a platform route that reads the lab runtime of the process (as the exports, ADR 0060).
2. **Alert:** a live event on the admin stream / mail to the other admins and the company's owner.
3. **What is recorded where:** the reason in the audit log / the reason in the session row, the audit entries carry the session id.
4. **Review:** any admin / an admin other than the session's own (also a table check).

## Decision
- **A platform route** `readBreakGlassAttempt` reads the attempt's results, evidence (flag-shaped text redacted) and timeline from the lab runtime, only for the session's own admin while it is open; IF-2 is unchanged and the lab's reviewer routes still answer an admin with 404.
- **Sessions** in `break_glass_sessions` (migration 0016, the architecture's columns `admin_id`, `attempt_id`, `reason`, `started_at`, `expires_at`, `reviewed_by`, `reviewed_at`, `what_read`, plus `org_id`, `closed_at`, `review_note`); the application role inserts and selects and updates only `closed_at`, `what_read` and the review; a check refuses a review by the session's own admin.
- **15 minutes** (D-94); a learner's practice attempt cannot be opened.
- **The alert is a mail** (`admin.break_glass_opened` to every other active admin, `company.break_glass_opened` to the company's owner), queued in the same transaction as the session; the IF-3 events are unchanged.
- **The audit log** is read through `listAuditLog` over `DbAuditPort.entries`; each read writes `admin.audit_read`. The reason text is never in the audit log.
- **Incident handling** (D-95): `docs/runbooks/incident-procedure.md` (a draft for legal review, no time target) and `python -m vulnmart.admin.incident` to mail affected people (`security.incident_notice`, audited with counts). **Legal review** (FR-PRV-19): `docs/legal/review-pack.md`, OI-33 open.

## Consequences
- An admin sees candidate content only through an alerted, recorded, reviewed 15-minute session.
- The alert is as fast as the mail queue (seconds), not a live push.
- Who decides in an incident is not named yet (the procedure says so).

## Evidence
- `apps/api/tests/test_breakglass.py`, `test_breakglass_postgres.py`, `test_incident.py`, `test_privacy_wall.py`; the stack test: see the dev-log of P-31.
