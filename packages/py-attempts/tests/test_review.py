"""FR-ACH-07, FR-SCR-10, D-92 (OI-38): held captures wait for a named reviewer; every decision is audited."""
from datetime import timedelta

import pytest
from conftest_engine import T0

from vulnmart_attempts import FakeClock, Fact, Milestone, compute_score
from vulnmart_attempts.attempt_log import validate_event
from vulnmart_attempts.review import (
    NOTE_LIMIT,
    HeldCaptureReview,
    HeldItem,
    InMemoryAudit,
    InMemoryHeldStore,
    NotHeld,
    ReviewFinal,
    ReviewForbidden,
    default_may_review,
)

M2, M3 = Milestone.M2, Milestone.M3
RECRUITER = {"id": "r1", "role": "recruiter", "org_id": "org1"}
ADMIN = {"id": "ad1", "role": "admin", "org_id": "org1"}


def rig():
    clock = FakeClock(T0)
    store, audit, events = InMemoryHeldStore(), InMemoryAudit(), []
    store.add(HeldItem("a1", "C05", M3, M2, T0, ("ev1", "ev2")))
    review = HeldCaptureReview(store, audit, clock, default_may_review({"a1": "org1"}), events.append)
    return clock, store, audit, events, review


def shown(item):
    return compute_score({"C05": item.to_fact()}).shown


def test_held_lists_open_captures_with_evidence_ids():
    *_, review = rig()
    (item,) = review.held("a1")
    assert item.challenge_key == "C05" and item.evidence_ids == ("ev1", "ev2")
    assert review.held("nobody") == ()


def test_open_held_capture_counts_only_the_fallback_not_zero():
    *_, store, _a, _e, _r = (None, *rig()[1:])
    # by hand: fallback M2 = 40% of the Easy weight 60 = 24 of 960, 1000 x 24 / 960 = 25
    assert shown(store.get("a1", "C05")) == 25


def test_accept_releases_the_capture_audits_and_recomputes_the_score():
    clock, store, audit, _e, review = rig()
    clock.set(T0 + timedelta(hours=3))
    done = review.decide("a1", "C05", RECRUITER, "accept", "evidence checked")
    assert done.status == "accepted" and review.held("a1") == ()
    # by hand: full M3 on the Easy weight 60 = 60 of 960, 1000 x 60 / 960 = 62.5, rounded half up to 63
    assert shown(done) == 63
    (row,) = audit.rows
    assert (row.reviewer, row.decision, row.at, row.attempt_id) == ("r1", "accept", T0 + timedelta(hours=3), "a1")
    assert row.note == "evidence checked" and len(row.note_id) == 16


def test_reject_keeps_it_excluded_and_does_not_zero_the_attempt():
    *_, store, audit, _e, review = (None, *rig())
    done = review.decide("a1", "C05", ADMIN, "reject", "path does not match")
    assert done.status == "rejected" and review.held("a1") == ()
    assert shown(done) == 25 and done.to_fact().held       # still excluded, still the earlier milestone
    assert [r.decision for r in audit.rows] == ["reject"]


@pytest.mark.parametrize("reviewer", [
    {"id": "r9", "role": "recruiter", "org_id": "org2"},   # other organisation
    {"id": "l1", "role": "learner", "org_id": "org1"},     # learner
    {"id": "x", "role": "candidate", "org_id": "org1"},
])
def test_wrong_reviewer_is_refused_and_no_audit_row(reviewer):
    _c, store, audit, _e, review = rig()
    with pytest.raises(ReviewForbidden):
        review.decide("a1", "C05", reviewer, "accept")
    assert audit.rows == [] and store.get("a1", "C05").status == "open"


def test_unknown_attempt_is_not_reviewable():
    *_, audit, _e, review = rig()
    with pytest.raises(ReviewForbidden):
        review.decide("zz", "C05", RECRUITER, "accept")
    assert audit.rows == []


def test_repeat_same_decision_is_idempotent_no_second_audit_row():
    *_, audit, _e, review = (None, *rig())
    review.decide("a1", "C05", RECRUITER, "accept")
    review.decide("a1", "C05", RECRUITER, "accept")
    assert len(audit.rows) == 1


def test_conflicting_repeat_is_final():
    *_, audit, _e, review = (None, *rig())
    review.decide("a1", "C05", RECRUITER, "reject")
    with pytest.raises(ReviewFinal):
        review.decide("a1", "C05", RECRUITER, "accept")
    assert len(audit.rows) == 1


def test_bad_decision_and_unheld_challenge():
    *_, audit, _e, review = (None, *rig())
    with pytest.raises(ValueError):
        review.decide("a1", "C05", RECRUITER, "auto-zero")
    with pytest.raises(NotHeld):
        review.decide("a1", "C09", RECRUITER, "accept")
    assert audit.rows == []


def test_note_is_cut_at_500_characters():
    *_, audit, _e, review = (None, *rig())
    review.decide("a1", "C05", RECRUITER, "accept", "x" * 900)
    assert len(audit.rows[0].note) == NOTE_LIMIT == 500


def test_overdue_reminder_after_seven_days_once_and_still_held():
    clock, store, _a, events, review = rig()
    clock.set(T0 + timedelta(days=7) - timedelta(seconds=1))
    assert review.remind_overdue() == ()
    clock.set(T0 + timedelta(days=8))
    assert len(review.remind_overdue()) == 1
    assert review.remind_overdue() == ()
    (event,) = events
    assert event["event"] == "held_review_overdue" and set(event) == {"event", "attempt_id", "at", "challenge_key"}
    validate_event(event)
    assert store.get("a1", "C05").status == "open"          # no deadline changes a score


def test_activity_check_flag_mode_capture_counts_without_hold():
    # flag-only mode: the capture counts in full (63), a held one would show 25
    assert compute_score({"C05": Fact(M3)}).shown == 63
