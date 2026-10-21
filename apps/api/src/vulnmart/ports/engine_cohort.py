"""The platform adapter of the private cohort view (story L-28, FR-SCR-07 and 08, D-93 for OI-26). Stream L owns it; the route and the screen are stream P's (handoff H-346).

The library (`vulnmart_attempts.cohort`) decides who is on the board and in what order. This class only fetches the rows: the attempts of ONE company and ONE assessment
that ended (`submitted` or `reported`), their score facts, their last capture and their estimated active time. The company that owns the assessment and the setting
`cohort_board` come from the platform (the assessment record), never from a candidate id; a caller from another company, or one with no company, is refused before any
row is read. There is no function here that lists across companies.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator

from vulnmart_attempts import AttemptState, Catalogue, ScoringRules, compute_score
from vulnmart_attempts.cohort import CohortCandidate, CohortDisabled, CohortForbidden, CohortView, build_cohort
from vulnmart_attempts.ranking import RankRow

from vulnmart.ports.engine_reports import FactSource

__all__ = ["CohortDisabled", "CohortForbidden", "CohortView", "EngineCohortPort"]


def base_template(template_id: str | None) -> str | None:
    """A re-invite runs under the key `<template>~2`; it is the same assessment."""
    return template_id.split("~", 1)[0] if template_id else None


class EngineCohortPort:
    def __init__(self, *, engine, facts: FactSource, milestones, active_seconds_of: Callable[[str], int | None],
                 catalogue: Catalogue | None = None, rules: ScoringRules | None = None,
                 profile: Callable[[str], tuple[Catalogue, ScoringRules]] | None = None) -> None:
        self._profile = profile  # the challenges and hint costs of each attempt (its template)
        self._engine, self._facts, self._milestones, self._active = engine, facts, milestones, active_seconds_of
        self._catalogue, self._rules = catalogue or Catalogue(), rules or ScoringRules()

    def cohort(self, scope_org_id: str | None, assessment_org_id: str, assessment_id: str, board_enabled: bool) -> CohortView:
        """Raises CohortForbidden (the scope does not own the assessment) or CohortDisabled (the assessment keeps the board off). Ids only, never a name."""
        return build_cohort(scope_org_id, assessment_org_id, assessment_id, board_enabled, self._candidates(assessment_org_id, assessment_id))

    def _candidates(self, org_id: str, assessment_id: str) -> Iterator[CohortCandidate]:
        for rec in self._engine.in_states(AttemptState.SUBMITTED, AttemptState.REPORTED):
            if rec.org_id != org_id or base_template(rec.template_id) != assessment_id or rec.purged_at is not None:
                continue
            catalogue, rules = self._profile(rec.id) if self._profile is not None else (self._catalogue, self._rules)
            score = compute_score(self._facts.facts(rec.id), catalogue, rules)
            captures = self._milestones.captures(rec.id)
            last = max(captures.values()) if captures else None
            yield CohortCandidate(RankRow(rec.id, score, last, self._active(rec.id)), rec.state, held_open=len(self._milestones.held_for(rec.id)))