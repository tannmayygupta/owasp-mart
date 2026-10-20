# 0060. Exports built on the server as audited zips

- **Status:** Proposed (the builder's design for the developer to confirm; OI-27 answered by the developer on 2026-10-20)
- **Date:** 2026-10-20
- **Deciders:** Claude Code (design); the developer (OI-27: a recruiter exports scores as CSV and JSON, no evidence)
- **Requirements:** FR-EXP-01 to 04, FR-PRV-11, OI-27, ADR 0055, ADR 0059, handoff H-145

## Context
FR-EXP-01 and 02 ask for a person's own data as a zip of JSON and CSV with no flag value and no other user's data; FR-EXP-03 for a recruiter's export of results (format left to OI-27); FR-EXP-04 that every export is audited. The person's results live in the lab (stream L); the profile, consents, view history and deletion requests in the platform.

## Options considered
1. **Where the zip is made:** in the browser from the API answers / on the server.
2. **Lab data:** call the lab's HTTP routes from the server / read the lab runtime of the same process / a new lab port.
3. **Recruiter format (OI-27):** scores CSV and JSON / plus evidence / plus a PDF.
4. **Flag safety:** trust that no flag is in the data / redact anything shaped like a flag.

## Decision
- **On the server**, so every export is one audited request (`export.own`, `export.company`) and the company export can write `exported` into each candidate's view history (H-145). Both routes are POST with the CSRF header (they write), rate limited per account (`rate_export_per_user_per_hour`, a placeholder of 10).
- **The lab runtime of the process, read only** (`engine.for_user`, `score_rows`, `time_metrics`, `reports.evidence`, `integrity.of`), as the admin's force-stop does (ADR 0057); without a lab in the process the export says so and leaves the attempts out.
- **OI-27 (developer):** per candidate the invite and attempt state, score, times, hints used, open integrity flags and points per challenge, as CSV and JSON; no evidence.
- **Redaction:** anything shaped like a flag (`VM{...}`, any case) in a captured request is replaced by `VM{redacted}`; the export never reads the flag material. CSV cells that start like a formula are prefixed with a quote.

## Consequences
- A person can take their data; a company can take its results; both leave a trace.
- The export depends on the lab running in the API process (as today); a split deployment would need a lab port.
- The zips are built in memory (bounded by the 100 invites of one list and one person's attempts).

## Evidence
- `apps/api/tests/test_exports.py` (a learner who captured a flag: the flag value is not in the zip), `test_exports_company.py`; the stack test: see the dev-log of P-29.
