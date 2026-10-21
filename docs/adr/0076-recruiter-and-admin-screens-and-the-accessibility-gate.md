# 0076. Recruiter and admin screens, the real-route rule and the accessibility gate

- **Status:** Accepted (the leader's brief for work package F, 2026-10-21; the choices below are Claude's, as D-102 allows)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay) and Claude
- **Requirements:** FR-DSH-02, FR-DSH-05, FR-ORG-02, FR-ORG-03, FR-ORG-08, FR-ASM-01, FR-ASM-03, FR-ASM-05, FR-SES-07, FR-SCR-07, FR-SCR-08, FR-ADM-01, FR-PRV-08, FR-ACC-09; OI-30; D-93

## Context
The recruiter and admin dashboards drew only part of what the API can do, and OI-30 (browser tests and accessibility) was open. After work packages A and B the routes for the missing parts exist: the cohort board (`getCohort`), colleagues, deletion requests, the recruiter's cancel of an attempt, the invite cap per company, deleting a company, changing the email address.

## Options considered
1. Draw buttons for every API route at once and test by hand. Cons: nothing proves a screen works against the real API, and what is not tested rots.
2. Draw a control only where the API accepts the call (the state rules are copied into one function, `inviteActions`), show every refusal of the API in words, and test every journey in a real browser against the production build and the real API app; add an automated axe-core check of every main page.
3. A component library and a design system first. Cons: not asked for, no new risk removed.

## Decision
Option 2. Rules: (a) a screen calls a real route only, never a stand-in; (b) the backend decides, the screen never hides an authorisation failure (the browser tests include a refusal for each admin form); (c) there is no bulk route, so a bulk action is the chosen invites sent one by one, each checked by the API, with one summary; (d) the cohort screen uses the ranking-aid wording of D-93, has no decision control and joins attempt ids to names only from the company's own invites; (e) accessibility gate: `@axe-core/playwright` 4.11.3 (published 2026-04-30) runs the WCAG 2.0, 2.1 and 2.2 A and AA rules on every main page of every role, as the production build draws them, and any violation fails the test. First finding and fix: scrollable table wrappers were not keyboard reachable (`scrollable-region-focusable`), they are now focusable regions with a name.

## Consequences
Easier: a regression in a recruiter or admin journey, or an accessibility regression, fails in the browser suite. Harder: the suite is longer (about 2 minutes) and depends on the test API's seed (`apps/api/tests/e2e_web_server.py`), which now also wires the company, admin, deletion, break-glass and second-factor services and a hook that gives the current code of a seeded admin authenticator (a test secret that exists in that process only). Limits: axe finds about a third of the possible accessibility problems; a manual screen-reader pass and a mobile pass are still open. Break-glass is tested for its refusals only (no candidate attempt exists for an admin to open in the browser suite).

## Evidence
WCAG 2.2 and the axe-core rule set (Deque, https://github.com/dequelabs/axe-core, rule `scrollable-region-focusable`); Playwright (ADR 0070). Results: dev-log `2026-10-21-tannmayygupta-recruiter-admin-web-and-accessibility.md`.