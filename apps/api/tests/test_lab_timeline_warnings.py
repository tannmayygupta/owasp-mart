"""Handoff H-359 (IF-2 1.4.0): the time warnings the engine writes (`time_warning_sent`, 15 and 5 minutes before the end by default) are entries of the timeline, so the
recruiter's report shows when the candidate was told time was running out. Answers are checked against the schemas of the contract."""
from __future__ import annotations

from datetime import timedelta

from test_lab_api import Session, ada, check, start, world  # noqa: F401 - fixtures and helpers shared with the other lab route tests
from test_password_reset import EMAIL, clock, sessions  # noqa: F401


def timeline(who, attempt_id: str) -> dict:
    r = who.get(f"/api/v1/attempts/{attempt_id}/timeline")
    assert r.status_code == 200, r.text
    check("Timeline", r.json())
    return r.json()


def test_the_two_default_warnings_are_in_the_timeline_with_the_minutes_left(world, ada, clock):  # noqa: F811
    iid, aid = start(world, ada)
    assert [e["type"] for e in timeline(ada, aid)["items"]] == ["attempt.started"]
    deadline = world.lab.engine.get(aid).deadline_at
    clock.now = deadline - timedelta(minutes=14)
    world.lab.tick()
    reader = Session(world, EMAIL)  # the platform session of two hours ago has ended; a new sign-in at the new time reads the same attempt
    items = timeline(reader, aid)["items"]
    assert [(e["type"], e.get("minutes_left")) for e in items] == [("attempt.started", None), ("attempt.time_warning", 15)]
    clock.now = deadline - timedelta(minutes=4)
    world.lab.tick()
    reader = Session(world, EMAIL)
    again = timeline(reader, aid)["items"]
    assert [e.get("minutes_left") for e in again if e["type"] == "attempt.time_warning"] == [15, 5]
    warning = next(e for e in again if e["type"] == "attempt.time_warning")
    assert warning["challenge_key"] is None and warning["milestone"] is None and warning["result"] is None
    assert all("minutes_left" not in e for e in again if e["type"] != "attempt.time_warning"), "only a warning carries the number"


def test_a_repeated_tick_does_not_repeat_a_warning(world, ada, clock):  # noqa: F811
    iid, aid = start(world, ada)
    deadline = world.lab.engine.get(aid).deadline_at
    clock.now = deadline - timedelta(minutes=14)
    for _ in range(3):
        world.lab.tick()
    reader = Session(world, EMAIL)
    assert [e.get("minutes_left") for e in timeline(reader, aid)["items"] if e["type"] == "attempt.time_warning"] == [15]


def test_a_warning_in_the_log_is_shown_with_its_number(world, ada):  # noqa: F811
    iid, aid = start(world, ada)
    world.lab.attempt_log.append({"event": "time_warning_sent", "attempt_id": aid, "at": world.lab.clock().isoformat(), "state": "running", "minutes_left": 15})
    items = timeline(ada, aid)["items"]
    assert [e["minutes_left"] for e in items if e["type"] == "attempt.time_warning"] == [15]
