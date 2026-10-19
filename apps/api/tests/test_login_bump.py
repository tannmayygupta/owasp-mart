"""FR-SES-11 on the platform side (handoff H-341, story L-18): a new login raises the access epoch of the account's live instances, so the gate refuses
the ticket of the older browser tab. The platform sessions themselves are not touched (the user's session list and "log out everywhere" are story P-12)."""
from __future__ import annotations

import time

from test_lab_api import EMAIL, OTHER_EMAIL, Session, clock, sessions, start, world, ada, eve  # noqa: F401 - fixtures
from vulnmart.ports.instance_host import Access, OrchestratorError


def wait_for(predicate, seconds: float = 5.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_a_new_login_raises_the_epoch_of_the_live_instance_and_leaves_the_older_session_and_other_accounts_alone(world, ada, eve):
    iid, aid = start(world, ada)
    eve_iid, _ = start(world, eve)
    before, eve_before = world.host.get(iid).access_epoch, world.host.get(eve_iid).access_epoch
    ticket_one = ada.post(f"/api/v1/instances/{iid}/open").json()["url"]

    newer = Session(world, EMAIL)  # a second login of the same account
    assert wait_for(lambda: world.host.get(iid).access_epoch == before + 1), "the epoch of ada's instance was raised"
    st = world.host.get(iid)
    assert st.access is Access.OPEN, "the instance stays open: only the epoch moves"
    assert world.host.get(eve_iid).access_epoch == eve_before, "another account's instance is not touched"
    ticket_two = newer.post(f"/api/v1/instances/{iid}/open").json()["url"]
    assert ticket_two != ticket_one, "the new login gets a ticket of the new epoch"
    assert ada.get(f"/api/v1/attempts/{aid}").status_code == 200, "the older platform session still works (the gate, not the API, ends the older tab)"


def test_a_closed_or_frozen_instance_is_not_bumped_and_a_missing_one_is_skipped(world, ada):
    iid, aid = start(world, ada)
    ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True})  # frozen after the submit
    epoch = world.host.get(iid).access_epoch
    assert world.lab.bump_access_for_user("u-AAAAAAAAAAAAAAAA") == 0
    assert world.host.get(iid).access_epoch == epoch
    assert world.lab.bump_access_for_user("u-nobody") == 0


def test_a_failed_bump_is_retried_by_the_next_tick(world, ada):
    iid, aid = start(world, ada)
    epoch = world.host.get(iid).access_epoch
    real, calls = world.host.set_access, {"n": 0}

    def flaky(instance_id, access, access_epoch):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OrchestratorError("the orchestrator was away")
        return real(instance_id, access, access_epoch)

    world.host.set_access = flaky
    assert world.lab.bump_access_for_user("u-AAAAAAAAAAAAAAAA") == 0, "the failure is swallowed, the login is not affected"
    assert world.host.get(iid).access_epoch == epoch
    world.lab.tick()
    assert world.host.get(iid).access_epoch == epoch + 1, "the retry of the tick raised it"
    world.lab.tick()
    assert world.host.get(iid).access_epoch == epoch + 1, "and only once"