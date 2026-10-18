import random
from datetime import UTC, datetime, timedelta, timezone

import pytest

from vulnmart_attempts import (
    AttemptTimes,
    Rules,
    accepts_request,
    deadline_for,
    destroy_due,
    expiry_due,
    frozen_until_for,
    warnings_due,
)

T = datetime(2026, 10, 19, 9, 0, 0, tzinfo=UTC)
R = Rules()
DEADLINE = T + timedelta(minutes=120)


def running() -> AttemptTimes:
    return AttemptTimes(ready_at=T, started_at=T, deadline_at=deadline_for(T, R))


def test_start_deadline_is_ready_plus_limit():
    assert deadline_for(T, R) == T + timedelta(minutes=120)
    assert deadline_for(T, Rules(time_limit_minutes=45)) == T + timedelta(minutes=45)


def test_deadline_in_another_offset_is_same_instant():
    ist = timezone(timedelta(hours=5, minutes=30))
    assert deadline_for(T.astimezone(ist), R) == DEADLINE


def test_grace_boundaries():
    t = running()
    assert accepts_request(DEADLINE, t, R)
    assert accepts_request(DEADLINE + timedelta(seconds=30), t, R)
    assert accepts_request(DEADLINE + timedelta(seconds=59), t, R)
    assert accepts_request(DEADLINE + timedelta(seconds=60), t, R)
    assert not accepts_request(DEADLINE + timedelta(seconds=61), t, R)
    assert not accepts_request(DEADLINE + timedelta(hours=3), t, R)


def test_accepts_before_clock_started():
    assert accepts_request(T, AttemptTimes(ready_at=T), R)


def test_warnings_matrix():
    t = running()
    at = lambda m: DEADLINE - timedelta(minutes=m)  # noqa: E731
    assert warnings_due(at(30), t, R, ()) == ()
    assert warnings_due(at(15.001), t, R, ()) == ()
    assert warnings_due(at(15), t, R, ()) == (15,)
    assert warnings_due(at(14), t, R, ()) == (15,)
    assert warnings_due(at(14), t, R, (15,)) == ()
    assert warnings_due(at(5), t, R, (15,)) == (5,)
    assert warnings_due(at(3), t, R, ()) == (15, 5)  # late: both, in order
    assert warnings_due(at(3), t, R, [15, 5]) == ()  # never twice
    assert warnings_due(at(3), t, R, {5}) == (15,)


def test_no_warning_at_or_after_deadline_or_after_submit():
    t = running()
    assert warnings_due(DEADLINE, t, R, ()) == ()
    assert warnings_due(DEADLINE + timedelta(minutes=1), t, R, ()) == ()
    done = AttemptTimes(started_at=T, deadline_at=DEADLINE, submitted_at=DEADLINE - timedelta(minutes=10))
    assert warnings_due(DEADLINE - timedelta(minutes=3), done, R, ()) == ()


def test_custom_warning_set():
    r = Rules(warning_minutes=(30, 1))
    t = AttemptTimes(started_at=T, deadline_at=deadline_for(T, r))
    assert warnings_due(DEADLINE - timedelta(minutes=29), t, r, ()) == (30,)
    assert warnings_due(DEADLINE - timedelta(seconds=30), t, r, ()) == (30, 1)


def test_expiry_due_even_after_hours_without_contact():
    t = running()
    assert not expiry_due(DEADLINE - timedelta(seconds=1), t)
    assert expiry_due(DEADLINE, t)
    assert expiry_due(DEADLINE + timedelta(hours=9), t)


def test_expiry_not_due_when_submitted_or_not_started():
    assert not expiry_due(DEADLINE + timedelta(hours=1), AttemptTimes(started_at=T, deadline_at=DEADLINE, submitted_at=T))
    assert not expiry_due(DEADLINE, AttemptTimes(ready_at=T))


def test_clock_moved_back_nothing_due_no_error():
    t = AttemptTimes(started_at=T, deadline_at=DEADLINE, frozen_until=T)
    early = T - timedelta(minutes=5)
    assert warnings_due(early, t, R, ()) == ()
    assert not expiry_due(early, t)
    assert not destroy_due(early, t)


def test_freeze_end_exact():
    submitted = DEADLINE
    fu = frozen_until_for(submitted, R)
    assert fu == submitted + timedelta(minutes=15)
    t = AttemptTimes(started_at=T, deadline_at=DEADLINE, submitted_at=submitted, frozen_until=fu)
    assert not destroy_due(fu - timedelta(microseconds=1), t)
    assert destroy_due(fu, t)
    assert destroy_due(fu + timedelta(hours=3), t)
    assert not destroy_due(fu, AttemptTimes(started_at=T, deadline_at=DEADLINE))


def test_naive_datetimes_refused_everywhere():
    naive = datetime(2026, 10, 19, 9, 0, 0)
    t = running()
    with pytest.raises(ValueError):
        deadline_for(naive, R)
    with pytest.raises(ValueError):
        frozen_until_for(naive, R)
    with pytest.raises(ValueError):
        accepts_request(naive, t, R)
    with pytest.raises(ValueError):
        warnings_due(naive, t, R, ())
    with pytest.raises(ValueError):
        expiry_due(naive, t)
    with pytest.raises(ValueError):
        destroy_due(naive, t)
    for field in ("ready_at", "started_at", "deadline_at", "submitted_at", "frozen_until"):
        with pytest.raises(ValueError):
            AttemptTimes(**{field: naive})


def test_same_inputs_same_answer():
    t = running()
    now = DEADLINE - timedelta(minutes=4)
    first = (accepts_request(now, t, R), warnings_due(now, t, R, ()), expiry_due(now, t), destroy_due(now, t))
    for _ in range(5):
        assert (accepts_request(now, t, R), warnings_due(now, t, R, ()), expiry_due(now, t), destroy_due(now, t)) == first


def test_random_instants_agree_with_slow_reference():
    rng = random.Random(7)
    t = running()
    for _ in range(3000):
        offset = rng.uniform(-7300, 7300)  # seconds around the deadline, both sides
        now = DEADLINE + timedelta(seconds=offset)
        sent = {m for m in R.warning_minutes if rng.random() < 0.4}

        # Slow reference, written differently: whole seconds-to-deadline arithmetic.
        left = (DEADLINE - now).total_seconds()
        assert accepts_request(now, t, R) == (left >= -60)
        assert expiry_due(now, t) == (left <= 0)
        ref = []
        for m in (15, 5):
            if m not in sent and left > 0 and left <= m * 60:
                ref.append(m)
        assert warnings_due(now, t, R, sent) == tuple(ref)
        # An attempt is never both expiring and warning.
        assert not (expiry_due(now, t) and warnings_due(now, t, R, sent))
        # Second warning is never due while the first is unsent and not due.
        due = warnings_due(now, t, R, sent)
        if 5 in due and 15 not in sent:
            assert 15 in due


def test_expiry_monotonic_over_time():
    t = running()
    seen = False
    for s in range(-600, 600, 7):
        now = DEADLINE + timedelta(seconds=s)
        cur = expiry_due(now, t)
        assert not (seen and not cur)
        seen = seen or cur
