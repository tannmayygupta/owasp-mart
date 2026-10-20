"""Story 2.3 (FR-SES-03, FR-NTF-04): the time warnings are recorded once each, by the engine's tick in the lab runtime (the attempt log's `time_warning_sent`), as the
API process runs it. The pages show the same warnings from `deadline_at` on the reader's clock (`timeWarning` in apps/web/lib/api.ts, tested in
apps/web/test/dashboard-lib.test.mjs); this test pins the server side the pages rely on: the thresholds and the once-only record."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from vulnmart_attempts import FakeClock

from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.fake_instance_host import FakeInstanceHost

T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)


def warnings(rt, attempt_id):
    return [(e["minutes_left"], e["state"]) for e in rt.attempt_log.read(attempt_id) if e["event"] == "time_warning_sent"]


def test_a_deadline_in_14_minutes_gives_one_warning_then_another_at_5_each_recorded_once():
    clock = FakeClock(T0)
    rt = build_lab_runtime({}, host=FakeInstanceHost(), clock=clock)
    attempt_id = rt.start_attempt("u-1").attempt_id
    deadline = datetime.fromisoformat(rt.state(attempt_id)["deadline_at"])

    clock.set(deadline - timedelta(minutes=16))
    rt.tick()
    assert warnings(rt, attempt_id) == [], "nothing before 15 minutes are left"

    clock.set(deadline - timedelta(minutes=14))
    rt.tick()
    rt.tick()
    assert warnings(rt, attempt_id) == [(15, "running")], "one warning at 15 minutes, recorded once however often the tick runs"

    clock.set(deadline - timedelta(minutes=5))
    rt.tick()
    clock.advance(seconds=30)
    rt.tick()
    assert warnings(rt, attempt_id) == [(15, "running"), (5, "running")]


def test_a_late_first_tick_records_only_the_urgent_warning():
    clock = FakeClock(T0)
    rt = build_lab_runtime({}, host=FakeInstanceHost(), clock=clock)
    attempt_id = rt.start_attempt("u-1").attempt_id
    deadline = datetime.fromisoformat(rt.state(attempt_id)["deadline_at"])
    clock.set(deadline - timedelta(minutes=3))
    rt.tick()
    assert warnings(rt, attempt_id) == [(5, "running")], "the page shows 5 at this point too (timeWarning)"
