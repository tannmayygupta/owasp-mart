"""FR-TIM-01 to FR-TIM-03: expected numbers are worked out by hand from the PRD."""
from datetime import UTC, datetime, timedelta

import pytest

from vulnmart_attempts.metrics import HEADLINE_LABEL, active_seconds, headline_seconds, reset_count, retry_counts, time_metrics

T0 = datetime(2026, 10, 17, 9, 0, 0, tzinfo=UTC)


def s(sec):
    return T0 + timedelta(seconds=sec)


def test_headline_is_754_for_a_capture_754_seconds_after_ready():
    assert headline_seconds(T0, {"C03": s(754)}) == {"C03": 754}


def test_headline_uses_the_same_start_for_every_challenge():
    assert headline_seconds(T0, {"C01": s(60), "C02": s(3600), "C03": s(0)}) == {"C01": 60, "C02": 3600, "C03": 0}


def test_headline_drops_sub_second_part():
    assert headline_seconds(T0, {"C01": s(10) + timedelta(milliseconds=999)}) == {"C01": 10}


def test_capture_before_ready_is_refused():
    with pytest.raises(ValueError):
        headline_seconds(T0, {"C03": s(-1)})


def test_naive_datetime_is_refused():
    with pytest.raises(ValueError):
        headline_seconds(T0, {"C03": datetime(2026, 10, 17, 9, 5)})
    with pytest.raises(ValueError):
        active_seconds([datetime(2026, 10, 17, 9, 5)])


def test_label_text():
    assert HEADLINE_LABEL == "time into the assessment"


def test_active_time_example_from_the_story():
    # gaps 100, 300, 600: only the 100 s gap is under 300 s
    assert active_seconds([s(0), s(100), s(400), s(1000)]) == 100


@pytest.mark.parametrize("gap, expected", [(299, 299), (300, 0), (301, 0)])
def test_idle_gap_boundary(gap, expected):
    assert active_seconds([s(0), s(gap)]) == expected


def test_duplicate_stamps_count_once_with_gap_zero():
    assert active_seconds([s(5), s(5), s(5)]) == 0
    assert active_seconds([s(0), s(0), s(10), s(10)]) == 10


def test_unsorted_input_is_sorted_and_empty_or_single_is_zero():
    assert active_seconds([s(200), s(0), s(100)]) == 200
    assert active_seconds([]) == 0 and active_seconds([s(7)]) == 0


def test_custom_idle_gap_and_bad_gap():
    assert active_seconds([s(0), s(60)], idle_gap_s=60) == 0
    assert active_seconds([s(0), s(59)], idle_gap_s=60) == 59
    with pytest.raises(ValueError):
        active_seconds([s(0)], idle_gap_s=0)


def test_determinism_same_input_same_output():
    stamps = [s(0), s(40), s(900), s(920)]
    assert active_seconds(stamps) == active_seconds(list(reversed(stamps))) == 60


def test_three_resets_and_two_retries_are_counted_separately():
    events = [{"event": "instance_reset"}] * 3 + [
        {"event": "flag_submitted", "challenge_key": "C01"},
        {"event": "flag_submitted", "challenge_key": "C01"},
        {"event": "flag_submitted", "challenge_key": "C02"},
        {"event": "hint_unlocked", "challenge_key": "C01"},
    ]
    assert reset_count(events) == 3
    assert retry_counts(events) == {"C01": 2, "C02": 1}


def test_time_metrics_bundle_and_start_is_never_moved_by_resets():
    events = [{"event": "instance_reset"}, {"event": "flag_submitted", "challenge_key": "C01"}]
    m = time_metrics(T0, {"C01": s(754)}, [s(0), s(100), s(400)], events)
    assert m.headline == {"C01": 754} and m.active_seconds == 100 and m.resets == 1 and m.retries == {"C01": 1}
    again = time_metrics(T0, {"C01": s(754)}, [s(0), s(100), s(400)], events + [{"event": "instance_reset"}])
    assert again.headline == m.headline and again.resets == 2
