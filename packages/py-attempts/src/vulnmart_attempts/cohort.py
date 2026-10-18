"""The private cohort view, library side (FR-SCR-07, D-93 for OI-26).

Scoped to one organisation and one assessment, off unless the assessment turns it on. There is no function
here that lists across organisations. The platform adapter (`EngineCohortPort`) only has to fetch the rows.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .ranking import RankedRow, RankRow, suggest_order
from .states import AttemptState


class CohortDisabled(Exception):
    """The assessment did not turn the cohort board on (`cohort_board` false)."""


class CohortForbidden(Exception):
    """The scope organisation is missing or differs from the assessment's organisation."""


@dataclass(frozen=True, slots=True)
class CohortCandidate:
    """One attempt of the assessment, ids only. `held_open` is the number of captures awaiting a reviewer."""

    rank_row: RankRow
    state: AttemptState
    held_open: int = 0


@dataclass(frozen=True, slots=True)
class CohortView:
    org_id: str
    assessment_id: str
    rows: tuple[RankedRow, ...]


def on_board(c: CohortCandidate) -> bool:
    """`reported`, or `submitted` with no open held capture. Withdrawn and everything else is not listed."""
    return c.state == AttemptState.REPORTED or (c.state == AttemptState.SUBMITTED and c.held_open == 0)


def build_cohort(scope_org_id: str | None, assessment_org_id: str, assessment_id: str, board_enabled: bool,
                 candidates: Iterable[CohortCandidate]) -> CohortView:
    if not scope_org_id or scope_org_id != assessment_org_id:
        raise CohortForbidden("the scope does not own this assessment")
    if not board_enabled:
        raise CohortDisabled("the cohort board is off for this assessment")
    rows = [c.rank_row for c in candidates if on_board(c)]
    return CohortView(scope_org_id, assessment_id, suggest_order(rows))
