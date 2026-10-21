---
id: story-wp-b-company-privacy-mail
title: Work package B, company administration, privacy workflows and real mail
state: done-pending-merge
initiative: initiative-lab
requirements: [FR-PRV-08, FR-PRV-09, FR-ORG-03, FR-ADM-01, FR-ACC-09, FR-ASM-04, FR-NTF-01, FR-NTF-03]
audit_items: [F-03, F-09, F-10, F-12, R-05, R-06, R-17, R-28, R-31, A-04, A-19, A-24, C-05, C-06, C-24, C-25, X-16, X-21]
branch: wp-b-company-privacy-mail
---

# Story: company administration, privacy workflows and real mail

## Acceptance
1. The company decides, lists and deletes candidate deletion requests; escalation after 14 days reminds the company and tells every active admin; every step is audited and mailed.
2. The owner lists and decides join requests, lists members and removes one; other companies' ids are 404.
3. An admin lists companies, deletes a company (decision `delete`) and sets or clears a company's invite cap.
4. The mails of FR-NTF-01 are enqueued: consent withdrawn, deletion requested, deletion request for the company, deletion confirmed, plus time warning, submission and released results.
5. A person can change the account's address with a verified link; a wrong or unverified address at `acceptInvite` gets a guided refusal.
6. Production refuses to start with Mailpit, a missing Brevo key or a placeholder sender; a test reads the deployed compose.
7. IF-1 1.8.0 with examples, bundle and generated clients; docs, dev-log, ADR 0073, traceability.

## Plan (done)
Routes over the existing services (`orgs/company_privacy_api.py`, `orgs/colleague_api.py`, admin and me routes); `notifications/triggers.py` and `lab/mail_log.py`;
`notifications/config.py`; migration 0018; tests `test_wp_b_routes.py`, `test_wp_b_mail_triggers.py`, `test_wp_b_mail_config.py`.

## Open
- WP-C: set Brevo, the key file and the sender in `infra/deploy/platform.compose.yaml` and remove the xfail marker of the compose test.
- WP-F or this package keeps `getCohort`; the web UIs for all of these routes.
- A cancel mail needs an engine event and a template.
