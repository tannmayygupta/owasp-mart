# Legal review pack (FR-PRV-19)

**Status:** waiting for the reviewer. **OI-33 is open**: who reviews (the guide or the institute's legal cell) and when is not decided. Prepared in story P-31.

FR-PRV-19 asks that the consent notice, the retention rules and the 18-and-over rule are reviewed once by the guide or the institute's legal cell, that the outcome is recorded here, and that any change becomes a new requirement.

## What to review

| Item | Where it is | Current rule |
|---|---|---|
| Consent notice shown to a candidate before an assessment | `apps/api/src/vulnmart/privacy/notice.py` and the notice text it renders; FR-PRV-01 | What is recorded and not recorded, why, who sees it, how long it is kept, the choices (see, download, request deletion, withdraw); the company named as the party that decides how results are used |
| Retention | `apps/api/src/vulnmart/ports/settings.py` (the defaults), ADR 0054, D-25 | Candidate record 180 days by default (30 to 365); learner data 12 months after the last login, with a warning 30 days before; consent record 12 months after the assessment record (OI-37); audit log 12 months, pseudonymised; backups 14 days with key shredding |
| Deletion and undo | ADR 0055, FR-PRV-08, FR-PRV-09 | 7-day undo; a candidate's request goes to the company, which decides within 14 days |
| 18 and over | Sign-up (`age_declaration`), FR-ACC-01, D-25 | A declaration at sign-up; no age verification |
| Data-processing terms for companies | `apps/api/src/vulnmart/orgs/data/dpa-terms.txt`, FR-ORG-07 | Accepted by the company's owner before any invite |
| Break-glass access | ADR 0062, D-94, FR-ADM-03 | 15 minutes, a written reason, alerts to the other admins and the company, a later review |
| Incident procedure | `docs/runbooks/incident-procedure.md`, D-95 | Draft, no time target |

None of the periods has been checked against India's DPDP Act 2023 or its rules; that is the question for the reviewer (OI-33).

## Outcome

| Date | Reviewer | Item | Outcome | New requirement |
|---|---|---|---|---|
| (not reviewed yet) | | | | |
