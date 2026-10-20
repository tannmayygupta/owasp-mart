# Incident procedure (DRAFT for legal review)

**Status:** draft, written in story P-31 (FR-PRV-20) as the developer decided (D-95, answers OI-34): a short procedure with **no time target**. The 72-hour figure in research RS-H is not verified and **not adopted**. This draft goes to the legal review of FR-PRV-19 (`docs/legal/review-pack.md`); until that review, follow it as written.

## When this applies
Any event that may have exposed, changed or lost personal data held by VulnMart: a leaked secret or key, an unexpected admin or break-glass access, a database or backup copied, a bug that showed one person's data to another, a lost laptop holding a backup.

It does **not** apply to the intended vulnerabilities of the lab shop: those are the exercise. It does apply if an instance escapes its isolation.

## Who decides
- Whoever notices the incident (any of the three developers) **starts** the procedure.
- **Who decides** whether people are told and what they are told is **not named yet**: the OI-34 answer set the shape of the procedure, not the person. To be filled in by the developers (and checked in the legal review).
- Every decision is written into the incident note (below), with who decided and when.

## Steps
1. **Contain.** Stop the leak first: revoke the secret or key (the key service can shred an attempt key), lock the account (admin area, Users, lock), stop the instance (admin area, force-stop), or take the service down (`node scripts/dev.mjs down` locally; on the VMs, the deploy runbook).
2. **Keep the evidence.** Do not delete logs. Read the audit log from the admin area (each read is itself recorded). Verify the audit chain (`DbAuditPort.verify`). Copy what you looked at into the incident note.
3. **Find who is affected.** From the audit log, the attempt log and the database, list the user ids whose data may be involved. Write how the list was made.
4. **Decide what to tell.** The person who decides (see above) settles: who is told, the plain-words summary of what happened, and the advice (for example "change your password", "we deleted the copy").
5. **Tell them.** On the server, inside the API container:
   `python -m vulnmart.admin.incident --user-ids-file affected.txt --summary "..." --advice "..."`.
   Each active account gets the email `security.incident_notice`; the audit log gets one `incident.notified` entry with how many were told (never the text).
6. **Fix and record.** Fix the cause. Write the incident note: what happened, when it was noticed, what was contained, who was affected, what they were told and when, the fix. Add a dev-log entry for the fix as usual.

## The incident note
One file per incident: `docs/incidents/YYYY-MM-DD-<short-name>.md` (no personal data in it: user ids only where needed, never addresses, flags, keys or passwords).

## Open for the legal review
- Whether a time limit applies (for example under India's DPDP Act 2023), and to whom a report is owed beyond the affected people.
- Who outside the project (the guide, the institute) must be told.
