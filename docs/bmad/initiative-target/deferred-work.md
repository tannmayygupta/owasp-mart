
## Deferred from: code review of story-challenge-catalogue-schema-and-11-stub-entries-if-7-plan (2026-10-09)

- No consistency rule between `flag.placement` and `flag.delivery` in the IF-7 schema/validator. Deferred: the stub placements are provisional and `delivery: env` has no matching placement, so a strict coupling could be wrong now. Confirm the real placement/delivery pairs per challenge in T-19..T-29 and add the rule then.
