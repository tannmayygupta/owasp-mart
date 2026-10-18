from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta, timezone

import pytest

from vulnmart_attempts import FakeClock, Rules, SystemClock, require_aware

T0 = datetime(2026, 10, 19, 9, 0, 0, tzinfo=UTC)


def test_defaults():
    r = Rules()
    assert (r.time_limit_minutes, r.grace_seconds, r.warning_minutes, r.freeze_minutes, r.reset_limit) == (120, 60, (15, 5), 15, 3)


def test_frozen():
    with pytest.raises(FrozenInstanceError):
        Rules().grace_seconds = 5  # type: ignore[misc]


def test_warnings_sorted_longest_first():
    assert Rules(warning_minutes=(5, 30, 15)).warning_minutes == (30, 15, 5)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"time_limit_minutes": 0}, {"time_limit_minutes": -1}, {"grace_seconds": -1}, {"freeze_minutes": -1},
        {"reset_limit": -1}, {"warning_minutes": (0,)}, {"warning_minutes": (120,)}, {"warning_minutes": (5, 5)},
    ],
)
def test_invalid_rules_refused(kwargs):
    with pytest.raises(ValueError):
        Rules(**kwargs)


def test_dict_round_trip_and_defaults():
    r = Rules(time_limit_minutes=90, warning_minutes=(10,), reset_limit=1)
    assert Rules.from_dict(r.to_dict()) == r
    assert Rules.from_dict({}) == Rules()
    assert Rules.from_dict({"time_limit_minutes": 60}).time_limit_minutes == 60


def test_require_aware():
    assert require_aware(T0) is T0
    with pytest.raises(ValueError):
        require_aware(datetime(2026, 1, 1))


def test_fake_clock():
    c = FakeClock(T0)
    assert c() == T0
    assert c.advance(minutes=5) == T0 + timedelta(minutes=5)
    c.set(T0)
    assert c() == T0
    with pytest.raises(ValueError):
        c.set(datetime(2026, 1, 1))
    with pytest.raises(ValueError):
        FakeClock(datetime(2026, 1, 1))


def test_system_clock_is_aware_utc():
    now = SystemClock()()
    assert now.tzinfo is not None and now.utcoffset() == timedelta(0)


def test_non_utc_aware_offset_is_accepted():
    ist = timezone(timedelta(hours=5, minutes=30))
    assert require_aware(datetime(2026, 1, 1, tzinfo=ist)).utcoffset() == timedelta(hours=5, minutes=30)


def test_from_dict_is_strict_about_types_and_unknown_members():
    # review finding B12
    from vulnmart_attempts import Rules

    assert Rules.from_dict(Rules().to_dict()) == Rules()
    for bad in ({"time_limit_minutes": 119.9}, {"time_limit_minutes": "120"}, {"reset_limit": True}, {"warning_minutes": "15"},
                {"warning_minutes": [15.5]}, {"activity_check_mode": 1}, {"nope": 1}):
        with pytest.raises(ValueError):
            Rules.from_dict(bad)
