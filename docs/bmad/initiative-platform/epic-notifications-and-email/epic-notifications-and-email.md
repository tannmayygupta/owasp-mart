---
type: epic
title: "Email works and never loses a message"
parent: initiative-platform
covers: [FR-NTF-01, FR-NTF-02, FR-NTF-03, FR-NTF-04]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Email works and never loses a message

## Description

Every email the platform needs (verification, reset, approval outcome, invites, withdrawal, deletion, warnings) is queued through an outbox, sent within the provider's daily cap, and visible to admins when it fails.

## Outcome

People receive the right email at the right time and nothing is lost under a daily cap; the signal is the acceptance criteria of FR-NTF-01 to 04 passing on the deployed site.

## Requirements

Numbered source: docs/prd/PRD.md section 5.18 (FR-NTF-01 to FR-NTF-04) and the invite queue requirement FR-ASM-06; provider choice is OI-32.

## Done when

1. The outbox, the worker and the email templates exist; verification and password-reset emails are delivered in the deployed environment and every other type is proven with a test send; each later epic verifies its own email type.
2. Sending 200 invites with a daily cap lower than that delivers all of them over time, in order, with status visible.
3. A failed send is retried with back-off and shown to admins.
4. The provider is confirmed with a verified sender for the production address (OI-32, OI-9).

## Boundaries

The outbox, the mail worker and the provider integration. Not the invite lifecycle (epic-assessments-and-invites) and not the retention warning schedule (epic-privacy-audit-and-keys), which only use this epic.

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.18
- decision, initial.md D-21 (Resend or Brevo)

## Notes

- Open question: Resend needs a verified sender domain and DuckDNS cannot publish SPF and DKIM, so Brevo single-sender may be required (OI-32, PRD issue P-15).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
