"""The three ports stream L provides (IF-9), as stream P proposes them, and their in-memory fakes: each fake satisfies its
Protocol and follows the state rules of architecture 04 section 10 and the vocabularies of IF-2."""
from __future__ import annotations

import re

import pytest
import yaml

from support import ROOT
from vulnmart.ports import errors
from vulnmart.ports.attempts import CANCELLABLE, WITHDRAWABLE, AttemptMode, AttemptPort, AttemptState
from vulnmart.ports.fakes import FakeQuotaPort
from vulnmart.ports.instance_host import Access, InstanceHost, InstanceState
from vulnmart.ports.instances import InstancePort
from vulnmart.ports.lab_fakes import FakeAttemptPort, FakeInstancePort, FakeReportPort
from vulnmart.ports.reports import CHALLENGE_KEYS, ChallengeResult, IntegrityFlag, IntegrityType, Milestone, ReportPort

LAB = yaml.safe_load((ROOT / "contracts" / "api" / "lab" / "lab.openapi.yaml").read_text(encoding="utf-8"))
SCHEMAS = LAB["components"]["schemas"]


def test_every_fake_satisfies_its_protocol():
    attempts = FakeAttemptPort()
    assert isinstance(attempts, AttemptPort)
    assert isinstance(FakeReportPort(attempts), ReportPort)
    assert isinstance(FakeInstancePort(attempts), InstancePort)


def test_instance_port_sits_above_instance_host_and_reuses_its_values():
    from vulnmart.ports import instance_host, instances
    # none of the orchestrator calls is redefined, and the state, access and health values are the same objects
    assert set(InstancePort.__dict__) & {"create", "destroy", "set_access", "list_instances", "host_status"} == set()
    assert (instances.InstanceState, instances.Access, instances.Health) == (instance_host.InstanceState, instance_host.Access, instance_host.Health)
    assert not isinstance(FakeInstancePort(FakeAttemptPort()), InstanceHost)


def test_the_vocabularies_are_the_ones_of_if2():
    assert [s.value for s in AttemptState] == SCHEMAS["AttemptState"]["enum"]
    assert [m.value for m in AttemptMode] == SCHEMAS["AttemptMode"]["enum"]
    assert [m.value for m in Milestone] == SCHEMAS["Milestone"]["enum"]
    assert list(CHALLENGE_KEYS) == [f"C{n:02d}" for n in range(1, 12)]


# ---- attempts ----

def test_create_from_consent_gives_a_ready_candidate_attempt_once_per_consent():
    attempts = FakeAttemptPort()
    a = attempts.create_from_consent(user_id="u-CCCCCCCCCCCCCCCC", org_id="o-1", template_id="t-1", invite_id="v-1", consent_id="k-1")
    assert (a.mode, a.state, a.org_id) == (AttemptMode.CANDIDATE, AttemptState.READY, "o-1")
    assert re.fullmatch(r"a-[A-Z2-7]{16}", a.attempt_id)
    assert attempts.create_from_consent(user_id="u-CCCCCCCCCCCCCCCC", org_id="o-1", template_id="t-1", invite_id="v-1", consent_id="k-1") == a


@pytest.mark.parametrize("state", list(AttemptState))
def test_cancel_and_withdraw_follow_the_state_machine(state):
    attempts = FakeAttemptPort()
    if state is AttemptState.DELETED:
        return  # a deleted attempt is purged, see the purge test
    a = attempts.seed(user_id="u-A", mode=AttemptMode.CANDIDATE, org_id="o-1", state=state)
    if state in CANCELLABLE:
        assert attempts.cancel(a.attempt_id, by="u-RECRUITER").state is AttemptState.CANCELLED
        assert attempts.cancelled_by[a.attempt_id] == "u-RECRUITER"
    else:
        with pytest.raises(errors.AttemptStateInvalid):
            attempts.cancel(a.attempt_id, by="u-RECRUITER")
    b = attempts.seed(user_id="u-A", mode=AttemptMode.CANDIDATE, org_id="o-1", state=state)
    if state in WITHDRAWABLE:
        assert attempts.withdraw(b.attempt_id).state is AttemptState.WITHDRAWN
    else:
        with pytest.raises(errors.AttemptStateInvalid) as err:
            attempts.withdraw(b.attempt_id)
        assert err.value.code.value == "ATT-INVALID-STATE"


def test_a_finished_attempt_cannot_be_cancelled():
    attempts = FakeAttemptPort()
    for state in (AttemptState.SUBMITTED, AttemptState.REPORTED, AttemptState.CANCELLED, AttemptState.WITHDRAWN, AttemptState.EXPIRED):
        a = attempts.seed(user_id="u-A", state=state)
        with pytest.raises(errors.AttemptStateInvalid):
            attempts.cancel(a.attempt_id, by="u-ADMIN")
        assert attempts.get(a.attempt_id).state is state, "a refused call changes nothing"


def test_purge_makes_the_attempt_gone_and_an_unknown_id_is_not_found():
    attempts = FakeAttemptPort()
    a = attempts.seed(user_id="u-A")
    attempts.purge(a.attempt_id)
    with pytest.raises(errors.AttemptGone) as err:
        attempts.get(a.attempt_id)
    assert err.value.http_status == 410
    with pytest.raises(errors.AttemptGone):
        attempts.purge(a.attempt_id)
    with pytest.raises(errors.AttemptNotFound):
        attempts.get("a-ZZZZZZZZZZZZZZZZ")


# ---- reports ----

def test_reports_read_only_known_attempts_and_challenges():
    attempts = FakeAttemptPort()
    reports = FakeReportPort(attempts, now=lambda: "2026-10-12T09:00:00Z")
    a = attempts.seed(user_id="u-A")
    assert reports.score(a.attempt_id).score == 0
    reports.put_score(a.attempt_id, 640, (ChallengeResult("C03", Milestone.M3, 1, 90),))
    assert reports.score(a.attempt_id).score == 640
    assert reports.challenge(a.attempt_id, "C03").milestone is Milestone.M3
    assert reports.challenge(a.attempt_id, "C04").milestone is Milestone.NONE
    with pytest.raises(errors.ChallengeNotFound):
        reports.challenge(a.attempt_id, "C12")
    with pytest.raises(errors.AttemptNotFound):
        reports.score("a-ZZZZZZZZZZZZZZZZ")
    with pytest.raises(ValueError):
        reports.put_score(a.attempt_id, 1001)


def test_evidence_and_integrity_flags_and_nothing_after_a_purge():
    attempts = FakeAttemptPort()
    reports = FakeReportPort(attempts)
    a = attempts.seed(user_id="u-A", mode=AttemptMode.CANDIDATE, org_id="o-1", state=AttemptState.SUBMITTED)
    item = reports.put_evidence(a.attempt_id, "C03", b"POST /api/checkout")
    reports.put_flag(a.attempt_id, IntegrityFlag("g-AAAAAAAAAAAAAAAA", IntegrityType.DECOY, "A decoy was submitted.", "open"))
    assert [e.evidence_id for e in reports.evidence(a.attempt_id)] == [item.evidence_id]
    assert reports.evidence_body(a.attempt_id, item.evidence_id) == b"POST /api/checkout"
    assert reports.integrity_flags(a.attempt_id)[0].type is IntegrityType.DECOY
    attempts.purge(a.attempt_id)
    for call in (reports.score, reports.evidence, reports.integrity_flags):
        with pytest.raises(errors.AttemptGone):
            call(a.attempt_id)
    with pytest.raises(errors.AttemptGone):
        reports.evidence_body(a.attempt_id, item.evidence_id)


# ---- instances ----

def test_one_instance_per_attempt_and_the_quota_decides_how_many_a_user_runs():
    attempts = FakeAttemptPort()
    quota = FakeQuotaPort()
    instances = FakeInstancePort(attempts, quota=quota)
    a1, a2 = attempts.seed(user_id="u-A"), attempts.seed(user_id="u-A")
    i1 = instances.request(a1.attempt_id, user_id="u-A")
    assert (i1.state, i1.access, i1.epoch) == (InstanceState.READY, Access.OPEN, 1)
    assert instances.request(a1.attempt_id, user_id="u-A") == i1, "the same attempt gets the same instance"
    with pytest.raises(errors.InstanceQuotaReached) as err:
        instances.request(a2.attempt_id, user_id="u-A")
    assert err.value.code.value == "INST-QUOTA-REACHED"
    quota.users["u-A"] = 2
    assert instances.request(a2.attempt_id, user_id="u-A").instance_id != i1.instance_id
    instances.stop(i1.instance_id)
    assert instances.capacity().running == 1
    with pytest.raises(errors.AttemptNotFound):
        instances.request("a-ZZZZZZZZZZZZZZZZ", user_id="u-A")


def _ask(instances, attempts, user, org=None):
    return instances.request(attempts.seed(user_id=user, org_id=org).attempt_id, user_id=user, org_id=org)


def test_the_quota_defaults_are_one_per_user_five_per_company_and_twenty_overall():
    from vulnmart.ports.quota import DEFAULT_COMPANY_MAX, DEFAULT_TOTAL_MAX, QuotaPort
    q = FakeQuotaPort()
    assert isinstance(q, QuotaPort)
    assert (q.limits("u-A"), q.limits("u-A", "o-1")) == (type(q.limits("u-A"))(1, None, 20), type(q.limits("u-A"))(1, 5, 20))
    assert (DEFAULT_COMPANY_MAX, DEFAULT_TOTAL_MAX) == (5, 20)


def test_a_second_live_instance_of_the_same_user_is_refused_and_creates_nothing():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts)
    _ask(instances, attempts, "u-A")
    a2 = attempts.seed(user_id="u-A")
    with pytest.raises(errors.InstanceQuotaReached) as err:
        instances.request(a2.attempt_id, user_id="u-A")
    assert err.value.code.value == "INST-QUOTA-REACHED"
    assert instances.capacity().running == 1, "the refused request created nothing"


def test_the_sixth_instance_of_a_company_is_refused_even_for_a_user_with_room():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts)
    for n in range(5):
        _ask(instances, attempts, f"u-{n}", "o-1")
    with pytest.raises(errors.InstanceQuotaReached) as err:
        _ask(instances, attempts, "u-5", "o-1")
    assert "company" in str(err.value)
    assert _ask(instances, attempts, "u-5", "o-2").state is InstanceState.READY, "another company is not affected"
    assert instances.capacity().running == 6


def test_the_twenty_first_instance_on_the_platform_is_refused():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts, total_memory_mb=65536)
    for n in range(20):
        _ask(instances, attempts, f"u-{n}", f"o-{n}")
    with pytest.raises(errors.InstanceQuotaReached) as err:
        _ask(instances, attempts, "u-X", "o-X")
    assert "platform" in str(err.value)
    assert instances.capacity().running == 20


def test_a_destroyed_or_failed_instance_frees_its_place_and_the_next_request_is_accepted():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts)
    first = _ask(instances, attempts, "u-A", "o-1")
    with pytest.raises(errors.InstanceQuotaReached):
        _ask(instances, attempts, "u-A", "o-1")
    instances.stop(first.instance_id)
    second = _ask(instances, attempts, "u-A", "o-1")
    with pytest.raises(errors.InstanceQuotaReached):
        _ask(instances, attempts, "u-A", "o-1")
    instances.advance(second.instance_id, InstanceState.FAILED, error_code="INST-START-FAILED")
    assert _ask(instances, attempts, "u-A", "o-1").state is InstanceState.READY


def test_a_repeat_of_an_accepted_request_is_never_refused_by_quota():
    attempts = FakeAttemptPort()
    quota = FakeQuotaPort()
    instances = FakeInstancePort(attempts, quota=quota)
    a = attempts.seed(user_id="u-A", org_id="o-1")
    first = instances.request(a.attempt_id, user_id="u-A", org_id="o-1")
    quota.total_max = 1
    quota.company_max = 1
    quota.user_max = 1
    assert instances.request(a.attempt_id, user_id="u-A", org_id="o-1") == first


def test_a_company_with_its_own_cap_and_a_lowered_total_are_obeyed():
    attempts = FakeAttemptPort()
    quota = FakeQuotaPort(total_max=3)
    quota.companies["o-1"] = 1
    instances = FakeInstancePort(attempts, quota=quota)
    _ask(instances, attempts, "u-A", "o-1")
    with pytest.raises(errors.InstanceQuotaReached):
        _ask(instances, attempts, "u-B", "o-1")
    _ask(instances, attempts, "u-B", "o-2")
    _ask(instances, attempts, "u-C", "o-3")
    with pytest.raises(errors.InstanceQuotaReached):
        _ask(instances, attempts, "u-D", "o-4")


def test_user_max_is_the_per_user_default_and_global_max_is_its_alias():
    q = FakeQuotaPort(user_max=3)
    assert (q.max_instances("u-A"), q.global_max) == (3, 3)
    q.global_max = 2
    assert q.user_max == 2 and FakeQuotaPort(global_max=4).user_max == 4
    assert q.limits("u-A").company is None, "without an organisation the company check is skipped, by design"


@pytest.mark.parametrize("state", [InstanceState.STOPPING, InstanceState.FAILED])
def test_a_repeat_of_an_accepted_request_is_not_refused_by_quota_when_its_instance_is_stopping_or_failed(state):
    attempts = FakeAttemptPort()
    quota = FakeQuotaPort(total_max=1)
    instances = FakeInstancePort(attempts, quota=quota)
    a = attempts.seed(user_id="u-A", org_id="o-1")
    first = instances.request(a.attempt_id, user_id="u-A", org_id="o-1")
    instances.advance(first.instance_id, state)
    _ask(instances, attempts, "u-B", "o-2") if state is InstanceState.FAILED else None  # the freed place may be taken meanwhile
    again = instances.request(a.attempt_id, user_id="u-A", org_id="o-1")
    assert again.instance_id == first.instance_id and again.state is state

def test_reset_gives_a_new_epoch_only_from_ready_active_or_idle():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts)
    i = instances.request(attempts.seed(user_id="u-A").attempt_id, user_id="u-A")
    assert instances.reset(i.instance_id).epoch == 2
    for state in (InstanceState.REQUESTED, InstanceState.PROVISIONING, InstanceState.FAILED, InstanceState.DESTROYED):
        instances.advance(i.instance_id, state)
        with pytest.raises(errors.InstanceStateInvalid):
            instances.reset(i.instance_id)


def test_a_ticket_only_for_an_open_instance_that_is_up():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts, auto_ready=False)
    i = instances.request(attempts.seed(user_id="u-A").attempt_id, user_id="u-A")
    assert i.state is InstanceState.REQUESTED
    with pytest.raises(errors.InstanceNotReady):
        instances.open_ticket(i.instance_id)
    instances.advance(i.instance_id, InstanceState.READY, access=Access.OPEN)
    assert instances.open_ticket(i.instance_id).url.startswith("https://")
    instances.advance(i.instance_id, InstanceState.ACTIVE, access=Access.FROZEN)
    with pytest.raises(errors.InstanceNotReady):
        instances.open_ticket(i.instance_id)


def test_stop_and_force_stop_and_unknown_instances():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts)
    i = instances.request(attempts.seed(user_id="u-A").attempt_id, user_id="u-A")
    assert instances.stop(i.instance_id).state is InstanceState.DESTROYED
    assert instances.stop(i.instance_id).state is InstanceState.DESTROYED, "stopping a stopped instance is not an error"
    j = instances.request(attempts.seed(user_id="u-B").attempt_id, user_id="u-B")
    assert instances.force_stop(j.instance_id, by="u-ADMIN").access is Access.CLOSED
    assert instances.forced_by[j.instance_id] == "u-ADMIN"
    for call in (instances.get, instances.open_ticket, instances.reset, instances.stop):
        with pytest.raises(errors.InstanceMissing):
            call("i-ZZZZZZZZZZZZZZZZ")


def test_capacity_counts_running_instances():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts, memory_per_instance_mb=512, total_memory_mb=2048)
    for n in range(3):
        instances.request(attempts.seed(user_id=f"u-{n}").attempt_id, user_id=f"u-{n}")
    c = instances.capacity()
    assert (c.total_memory_mb, c.used_memory_mb, c.running) == (2048, 1536, 3)


# ---- found by the review ----

def test_a_ticket_expires_after_it_is_issued():
    attempts = FakeAttemptPort()
    instances = FakeInstancePort(attempts, now=lambda: "2026-10-12T09:00:00Z")
    i = instances.request(attempts.seed(user_id="u-A").attempt_id, user_id="u-A")
    assert instances.open_ticket(i.instance_id).expires_at == "2026-10-12T09:01:00Z"


def test_an_unknown_evidence_id_is_the_same_not_found_as_another_attempt_s():
    attempts = FakeAttemptPort()
    reports = FakeReportPort(attempts)
    mine, theirs = attempts.seed(user_id="u-A"), attempts.seed(user_id="u-B")
    item = reports.put_evidence(theirs.attempt_id, "C03", b"x")
    for evidence_id in ("e-ZZZZZZZZZZZZZZZZ", item.evidence_id):
        with pytest.raises(errors.AttemptNotFound):
            reports.evidence_body(mine.attempt_id, evidence_id)


def test_the_report_fake_is_safe_across_threads():
    import threading
    attempts = FakeAttemptPort()
    reports = FakeReportPort(attempts)
    a = attempts.seed(user_id="u-A")
    threads = [threading.Thread(target=lambda: [reports.put_evidence(a.attempt_id, "C01", b"x") for _ in range(50)]) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(reports.evidence(a.attempt_id)) == 400
