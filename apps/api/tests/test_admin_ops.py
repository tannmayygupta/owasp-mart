"""Story P-28 (FR-ADM-01, 02, 04, 05, 06): the admin's operations on real company, role, status and account services over SQLite, a recording stand-in for the lab's stop and erase.
The routes are in test_admin_api.py and the same flows against Postgres as the application role in test_admin_postgres.py."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

import vulnmart.accounts.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from test_companies import ADMIN, ADMIN_SCOPE, GOOD, ORIGIN, T0, add_admin, audit, clock, companies, ended, entries, mails, org_row, sessions, signup, user_id, verify  # noqa: F401
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.roles import NotAnAdmin, RoleService
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.accounts.status import AccountStatusService, InvalidAccountState
from vulnmart.admin.ops import RANGES, AdminOps, NoStopper, NotAllowed, NotFound
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.kernel.settings import DbSettingsPort
from vulnmart.accounts.models import User, UserRole, UserSession
from vulnmart.lab.models import Attempt
from vulnmart.live.models import DomainEvent
from vulnmart.notifications.models import EmailOutbox
from vulnmart.orgs.service import InvalidTransition
from vulnmart.ports.errors import UnknownSetting
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.ports.settings import SETTINGS
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.models import ConsentRecord, SubjectMap
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService

LEARNER = "u-LEARNERONE222222"
LEARNER2 = "u-LEARNERTWO222222"
CAND = "u-CANDIDATECANDID2"
RECRUITER_SCOPE = Scope(user_id="u-RECRUITERONE2222", org_id="00000000-0000-0000-0000-000000000001", roles=frozenset({Role.RECRUITER}))
LEARNER_SCOPE = Scope(user_id=LEARNER, roles=frozenset({Role.LEARNER}))
ATTEMPT = "a-PRACTICEONE22222"


class Rig:
    def __init__(self, sessions, companies, audit, clock, ended, with_stopper=True):
        self.sessions, self.companies, self.audit, self.clock, self.ended = sessions, companies, audit, clock, ended
        add_admin(sessions)
        self.settings = FakeSettingsPort()
        self.roles = RoleService(sessions, audit)
        self.stopped, self.erased = [], []
        self.subjects = SubjectService(sessions)
        self.quotas = DbQuotaPort(sessions, self.settings)
        records = SqlAttemptRecords(sessions)
        self.deletion = DeletionService(sessions, None, records, self.settings, audit, self.subjects, self.erased.append, now=clock)
        self.hosts = SimpleNamespace(capacity_memory_mb=8192, used_memory_mb=2048, instances=3, health=SimpleNamespace(value="ok"))
        self.states = {"i1": "ready", "i2": "failed", "i3": "active"}
        self.jobs = [SimpleNamespace(name="log_purge", last_status="failed", interval=timedelta(days=1)),
                     SimpleNamespace(name="live_cleanup", last_status="succeeded", interval=timedelta(hours=1))]
        self.ops = AdminOps(
            sessions=sessions, roles=self.roles, companies=companies, status=AccountStatusService(sessions, self.roles, audit),
            accounts=AccountService(sessions, self.settings, public_origin=ORIGIN, now=clock, policy=PasswordPolicy()), settings=self.settings, quotas=self.quotas,
            audit=audit, records=records, deletion=self.deletion, end_sessions=ended.append,
            stopper=(lambda attempt_id: self.stopped.append(attempt_id) or "inst-1") if with_stopper else None,
            host_status=lambda: self.hosts, instance_states=lambda: self.states, job_status=lambda: self.jobs, pseudonym=self.subjects.pseudonym, now=clock)

    def user(self, uid, *, account_type="participant", roles=("learner",), status="active", email=None, name="Some Person"):
        email = email or f"{uid.lower()}@example.org"
        with self.sessions.begin() as s:
            s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash="a-hash-that-must-never-be-shown", display_name=name, status=status,
                       email_verified_at=T0, last_login_at=T0))
            s.flush()
            if account_type == "participant":
                for role in roles:
                    s.add(UserRole(user_id=uid, role=role, account_type="participant"))

    def session_row(self, uid, token="s1"):
        with self.sessions.begin() as s:
            s.add(UserSession(id_hash=token, user_id=uid, last_seen_at=T0, absolute_expires_at=T0 + timedelta(hours=12)))

    def attempt(self, uid, attempt_id=ATTEMPT, org=None):
        with self.sessions.begin() as s:
            s.add(Attempt(id=attempt_id, user_id=uid, template_id="t-" + attempt_id, org_id=org, state="running", version=0, record={}))

    def status_of(self, uid):
        with self.sessions() as s:
            s.expire_all()
            u = s.get(User, uid)
            return None if u is None else u.status

    def revoked(self, token="s1"):
        with self.sessions() as s:
            s.expire_all()
            return s.get(UserSession, token).revoked_at is not None

    def actions(self, action):
        return entries(self.audit, action)


@pytest.fixture
def rig(sessions, companies, audit, clock, ended):
    return Rig(sessions, companies, audit, clock, ended)


# ---- only an admin ----------------------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("scope", [RECRUITER_SCOPE, LEARNER_SCOPE, Scope(user_id="u-NOSUCHADMIN22222", roles=frozenset({Role.ADMIN})), Scope(user_id=None, roles=frozenset())])
def test_nothing_is_done_for_someone_who_is_not_an_active_admin(rig, scope):
    calls = [lambda: rig.ops.queue(scope), lambda: rig.ops.decide_company(scope, "x", "approve"), lambda: rig.ops.users(scope), lambda: rig.ops.act_on_user(scope, LEARNER, "lock", "r"),
             lambda: rig.ops.force_stop(scope, ATTEMPT), lambda: rig.ops.settings(scope), lambda: rig.ops.set_setting(scope, "email_daily_cap", 5), lambda: rig.ops.reset_setting(scope, "email_daily_cap"),
             lambda: rig.ops.quotas(scope), lambda: rig.ops.set_quota(scope, "global", None, 2), lambda: rig.ops.remove_quota(scope, "global", None), lambda: rig.ops.capacity(scope),
             lambda: rig.ops.jobs(scope)]
    for call in calls:
        with pytest.raises(NotAnAdmin):
            call()
    assert rig.audit.records == [] and rig.stopped == []


def test_an_admin_who_was_disabled_is_refused_even_with_the_scope_still_saying_admin(rig):
    with rig.sessions.begin() as s:
        s.get(User, ADMIN).status = "disabled"
    with pytest.raises(NotAnAdmin):
        rig.ops.settings(ADMIN_SCOPE)


# ---- the approval queue -----------------------------------------------------------------------------------------------------------------------

def test_the_queue_lists_the_companies_waiting_and_a_decision_moves_one(rig, sessions, companies):
    signup(companies)
    verify(sessions)
    [pending] = rig.ops.queue(ADMIN_SCOPE)
    assert (pending.name, pending.owner_email_domain) == ("Acme Security Ltd", "acme.example")
    rig.ops.decide_company(ADMIN_SCOPE, pending.org_id, "approve")
    assert rig.ops.queue(ADMIN_SCOPE) == []
    assert rig.actions("org.approved") and mails(sessions)[-1][0] == "org.approval_outcome"
    with pytest.raises(InvalidTransition):
        rig.ops.decide_company(ADMIN_SCOPE, pending.org_id, "approve")


def test_reject_suspend_and_reinstate_need_a_reason_and_an_unknown_company_is_not_found(rig, sessions, companies):
    signup(companies)
    verify(sessions)
    [pending] = rig.ops.queue(ADMIN_SCOPE)
    for decision in ("reject", "suspend", "reinstate"):
        with pytest.raises(InvalidInput) as raised:
            rig.ops.decide_company(ADMIN_SCOPE, pending.org_id, decision)
        assert raised.value.pointer == "/reason"
    with pytest.raises(InvalidInput):
        rig.ops.decide_company(ADMIN_SCOPE, pending.org_id, "delete", "x")
    with pytest.raises(NotFound):
        rig.ops.decide_company(ADMIN_SCOPE, "00000000-0000-0000-0000-0000000000ff", "approve")
    rig.ops.decide_company(ADMIN_SCOPE, pending.org_id, "reject", "not a real company")
    assert rig.ops.queue(ADMIN_SCOPE) == []


# ---- users ------------------------------------------------------------------------------------------------------------------------------------

def test_every_admin_read_of_personal_data_is_audited_without_the_search_text(rig):
    """Story P-30 (FR-DSH-05): reading the users or the approval queue writes an audit entry with the count, never what was searched for."""
    rig.user(LEARNER, name="Lena Learner", email="lena@college.example")
    rig.ops.users(ADMIN_SCOPE, query="lena@college.example")
    rig.ops.queue(ADMIN_SCOPE)
    [(_, actor, subject, details)] = rig.actions("admin.users_read")
    assert actor == ADMIN and subject is None and details == {"count": 1, "searched": True, "status": None}
    assert "lena" not in repr(rig.audit.records).lower()
    [(_, actor, _, details)] = rig.actions("admin.queue_read")
    assert actor == ADMIN and details == {"count": 0}


def test_users_are_found_by_name_address_or_id_and_nothing_secret_is_in_a_row(rig):
    rig.user(LEARNER, name="Lena Learner", email="lena@college.example")
    rig.user(LEARNER2, name="Other Person", email="other@school.example")
    rig.user("u-GONEACCOUNT22222", status="deleted", name="Lena Gone")
    assert [u.user_id for u in rig.ops.users(ADMIN_SCOPE, query="lena")] == [LEARNER]
    assert [u.user_id for u in rig.ops.users(ADMIN_SCOPE, query="school.example")] == [LEARNER2]
    assert [u.user_id for u in rig.ops.users(ADMIN_SCOPE, query=LEARNER2)] == [LEARNER2]
    assert rig.ops.users(ADMIN_SCOPE, query="100%") == [] and rig.ops.users(ADMIN_SCOPE, query="_") == []
    [row] = rig.ops.users(ADMIN_SCOPE, query="lena")
    assert row.roles == ("learner",) and row.account_type == "participant" and row.email == "lena@college.example"
    assert "hash" not in repr(row) and "password" not in repr(row).lower()
    assert {u.user_id for u in rig.ops.users(ADMIN_SCOPE, status="active")} >= {LEARNER, LEARNER2, ADMIN}
    assert len(rig.ops.users(ADMIN_SCOPE, limit=1)) == 1


def test_lock_ends_the_sessions_and_unlock_restores_the_account_and_both_are_audited(rig):
    rig.user(LEARNER)
    rig.session_row(LEARNER)
    assert rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "lock", "abuse of the signup") == "locked"
    assert rig.status_of(LEARNER) == "disabled" and rig.revoked()
    with pytest.raises(InvalidAccountState):
        rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "lock", "again")
    assert rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "unlock", "it was a mistake") == "unlocked"
    assert rig.status_of(LEARNER) == "active"
    assert [(a, s) for a, _, s, _ in rig.actions("account.suspended")] == [("account.suspended", LEARNER)] or rig.audit.records
    assert not any("abuse" in str(r.details) for r in rig.audit.records), "the reason's text is not copied into the log"


def test_a_reason_is_needed_and_an_admin_account_or_the_admins_own_cannot_be_changed_through_here(rig):
    rig.user(LEARNER)
    rig.user("u-SECONDADMIN22222", account_type="admin", email="admin2@example.org")
    for action in ("lock", "unlock", "delete"):
        with pytest.raises(InvalidInput) as raised:
            rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, action)
        assert raised.value.pointer == "/reason"
    for target in ("u-SECONDADMIN22222", ADMIN):
        for action in ("lock", "delete", "reset_password"):
            with pytest.raises(NotAllowed):
                rig.ops.act_on_user(ADMIN_SCOPE, target, action, "r")
    with pytest.raises(InvalidInput):
        rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "promote", "r")
    for unknown in ("u-NOSUCHACCOUNT222", "not-an-id"):
        with pytest.raises(NotFound):
            rig.ops.act_on_user(ADMIN_SCOPE, unknown, "lock", "r")
    assert rig.status_of("u-SECONDADMIN22222") == "active" and rig.status_of(ADMIN) == "active"


def test_a_reset_mails_the_accounts_own_address_and_never_a_password(rig, sessions):
    rig.user(LEARNER, email="lena@college.example")
    assert rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "reset_password") == "reset_sent"
    [(template, to, params)] = mails(sessions)
    assert (template, to) == ("account.password_reset", LEARNER) and "reset-password?token=" in params["link"]
    assert rig.actions("admin.user_reset_sent")
    rig.user(LEARNER2, status="disabled")
    with pytest.raises(InvalidAccountState):
        rig.ops.act_on_user(ADMIN_SCOPE, LEARNER2, "reset_password")


def test_deleting_a_participant_erases_the_practice_data_the_account_and_the_pseudonym(rig):
    rig.user(LEARNER)
    rig.attempt(LEARNER)
    pseudonym = rig.subjects.pseudonym(LEARNER)
    assert rig.ops.act_on_user(ADMIN_SCOPE, LEARNER, "delete", "asked by email") == "deleted"
    assert rig.status_of(LEARNER) is None and rig.erased == [ATTEMPT] and rig.subjects.identity(pseudonym) is None
    [(_, _, _, details)] = rig.actions("admin.user_deleted")
    assert details == {"outcome": "deleted"}


def test_a_participant_with_assessment_data_is_locked_instead_of_deleted(rig):
    rig.user(CAND, roles=("learner", "candidate"))
    rig.attempt(CAND, org="00000000-0000-0000-0000-000000000009", attempt_id="a-ASSESSMENTATT222")
    rig.session_row(CAND)
    assert rig.ops.act_on_user(ADMIN_SCOPE, CAND, "delete", "asked") == "locked_instead"
    assert rig.status_of(CAND) == "disabled" and rig.ended == [CAND]  # the real `end_sessions` is SessionService.revoke_all


def test_a_recruiter_account_is_marked_deleted_and_its_sessions_end(rig):
    rig.user("u-RECRUITERONE2222", account_type="recruiter", email="r@acme.example")
    rig.session_row("u-RECRUITERONE2222")
    assert rig.ops.act_on_user(ADMIN_SCOPE, "u-RECRUITERONE2222", "delete", "left the company") == "deleted"
    assert rig.status_of("u-RECRUITERONE2222") == "deleted" and rig.revoked()
    assert rig.ops.users(ADMIN_SCOPE, query="acme.example") == []


# ---- force-stop -------------------------------------------------------------------------------------------------------------------------------

def test_force_stop_destroys_the_instance_audits_it_and_mails_the_owner(rig, sessions):
    rig.user(LEARNER)
    rig.attempt(LEARNER)
    assert rig.ops.force_stop(ADMIN_SCOPE, ATTEMPT) == "inst-1"
    assert rig.stopped == [ATTEMPT]
    [(_, actor, subject, details)] = rig.actions("admin.instance_force_stopped")
    assert (actor, subject) == (ADMIN, LEARNER) and details == {"attempt": ATTEMPT, "org": None, "had_instance": True}
    assert mails(sessions) == [("instance.force_stopped", LEARNER, {})]


def test_force_stop_of_an_unknown_attempt_or_without_a_lab_does_nothing(sessions, companies, audit, clock, ended):
    rig = Rig(sessions, companies, audit, clock, ended)
    for bad in ("a-NOSUCHATTEMPT222", "nonsense"):
        with pytest.raises(NotFound):
            rig.ops.force_stop(ADMIN_SCOPE, bad)
    rig.user(LEARNER)
    rig.attempt(LEARNER)
    no_lab = Rig.__new__(Rig)
    no_lab.__dict__.update(rig.__dict__)
    no_lab.ops = AdminOps(sessions=sessions, roles=rig.roles, companies=companies, status=AccountStatusService(sessions, rig.roles, audit), accounts=None, settings=rig.settings,
                          quotas=rig.quotas, audit=audit, records=SqlAttemptRecords(sessions), deletion=None, end_sessions=ended.append, stopper=None, now=clock)
    with pytest.raises(NoStopper):
        no_lab.ops.force_stop(ADMIN_SCOPE, ATTEMPT)
    assert rig.actions("admin.instance_force_stopped") == [] and mails(sessions) == []


# ---- settings ---------------------------------------------------------------------------------------------------------------------------------

def test_every_setting_is_listed_with_its_default_and_its_range(rig):
    rows = {r.name: r for r in rig.ops.settings(ADMIN_SCOPE)}
    assert set(rows) == set(SETTINGS)
    assert (rows["candidate_retention_days"].value, rows["candidate_retention_days"].minimum, rows["candidate_retention_days"].maximum, rows["candidate_retention_days"].overridden) == (180, 30, 365, False)
    assert rows["hints_enabled_default"].minimum is None
    assert set(RANGES) <= set(SETTINGS), "a range names a real setting"


@pytest.mark.parametrize("value,ok", [(29, False), (30, True), (365, True), (366, False), (-1, False), (True, False), ("180", False), (180.5, False)])
def test_a_candidate_retention_default_outside_30_to_365_days_is_refused(rig, value, ok):
    if ok:
        assert rig.ops.set_setting(ADMIN_SCOPE, "candidate_retention_days", value).value == value
        assert rig.settings.get("candidate_retention_days") == value
    else:
        with pytest.raises(InvalidInput):
            rig.ops.set_setting(ADMIN_SCOPE, "candidate_retention_days", value)
        assert rig.settings.get("candidate_retention_days") == 180 and rig.actions("admin.setting_changed") == []


def test_a_change_is_audited_with_old_and_new_and_reset_returns_the_default(rig):
    rig.ops.set_setting(ADMIN_SCOPE, "invite_cap_per_company_per_day", 80)
    [(_, actor, _, details)] = rig.actions("admin.setting_changed")
    assert actor == ADMIN and details == {"name": "invite_cap_per_company_per_day", "old": 50, "new": 80}
    assert {r.name: r for r in rig.ops.settings(ADMIN_SCOPE)}["invite_cap_per_company_per_day"].overridden is True
    row = rig.ops.reset_setting(ADMIN_SCOPE, "invite_cap_per_company_per_day")
    assert (row.value, row.overridden) == (50, False) and rig.settings.get("invite_cap_per_company_per_day") == 50
    assert rig.actions("admin.setting_reset")[0][3] == {"name": "invite_cap_per_company_per_day", "old": 80, "had_override": True}


def test_a_boolean_setting_takes_a_boolean_and_an_unknown_name_is_not_found(rig):
    assert rig.ops.set_setting(ADMIN_SCOPE, "hints_enabled_default", False).value is False
    with pytest.raises(InvalidInput):
        rig.ops.set_setting(ADMIN_SCOPE, "hints_enabled_default", 0)
    for call in (lambda: rig.ops.set_setting(ADMIN_SCOPE, "no_such_setting", 1), lambda: rig.ops.reset_setting(ADMIN_SCOPE, "no_such_setting")):
        with pytest.raises(NotFound):
            call()


def test_the_real_settings_port_keeps_overrides_with_the_pseudonym_of_the_admin(sessions):
    port = DbSettingsPort(sessions)
    port.set("email_daily_cap", 100, updated_by="s-ABCDEFGHIJKLMNOP")
    assert port.get("email_daily_cap") == 100 and port.overrides() == {"email_daily_cap": (100, "s-ABCDEFGHIJKLMNOP")}
    port.set("email_daily_cap", 120)
    assert port.get("email_daily_cap") == 120
    assert port.clear("email_daily_cap") is True and port.clear("email_daily_cap") is False and port.get("email_daily_cap") == SETTINGS["email_daily_cap"]
    with pytest.raises(UnknownSetting):
        port.set("nope", 1)
    with pytest.raises(ValueError):
        port.set("email_daily_cap", True)


# ---- quotas -----------------------------------------------------------------------------------------------------------------------------------

def test_a_user_quota_beats_a_company_quota_which_beats_the_global_one_and_the_lab_reads_it_at_once(rig):
    org = "6f1c8f0e-0a5e-4a1c-9d5a-3f2d6a8b9c01"
    assert rig.quotas.max_instances(LEARNER, org) == 1
    rig.ops.set_quota(ADMIN_SCOPE, "global", None, 3)
    assert rig.quotas.max_instances(LEARNER, org) == 3
    rig.ops.set_quota(ADMIN_SCOPE, "org", org, 6)
    assert rig.quotas.max_instances(LEARNER, org) == 6 and rig.quotas.max_instances(LEARNER) == 3
    rig.ops.set_quota(ADMIN_SCOPE, "user", LEARNER, 0)
    assert rig.quotas.max_instances(LEARNER, org) == 0 and rig.quotas.max_instances(LEARNER2, org) == 6
    rig.ops.set_quota(ADMIN_SCOPE, "user", LEARNER, 2)
    assert rig.quotas.max_instances(LEARNER, org) == 2
    assert [(r.scope, r.scope_id, r.max_instances) for r in rig.ops.quotas(ADMIN_SCOPE)] == [("global", None, 3), ("org", org, 6), ("user", LEARNER, 2)]
    changed = rig.actions("admin.quota_changed")
    assert changed[-1][3] == {"scope": "user", "scope_id": LEARNER, "old": 0, "new": 2}


def test_a_company_quota_given_in_upper_case_is_stored_as_the_lab_looks_it_up(rig):
    org = "6f1c8f0e-0a5e-4a1c-9d5a-3f2d6a8b9c01"
    assert rig.ops.set_quota(ADMIN_SCOPE, "org", org.upper(), 7).scope_id == org
    assert rig.quotas.max_instances(LEARNER, org) == 7
    rig.ops.remove_quota(ADMIN_SCOPE, "org", org.upper())
    assert rig.quotas.rows() == []


def test_the_company_and_platform_caps_come_from_the_settings(rig):
    assert (rig.quotas.limits(LEARNER, "org-1").company, rig.quotas.limits(LEARNER, "org-1").total, rig.quotas.limits(LEARNER).company) == (5, 20, None)
    rig.ops.set_setting(ADMIN_SCOPE, "instance_company_cap", 9)
    rig.ops.set_setting(ADMIN_SCOPE, "instance_total_cap", 40)
    limits = rig.quotas.limits(LEARNER, "org-1")
    assert (limits.company, limits.total) == (9, 40)


@pytest.mark.parametrize("scope,scope_id,value,pointer", [
    ("global", "x", 1, "/scope_id"), ("user", None, 1, "/scope_id"), ("user", "not-a-user", 1, "/scope_id"), ("org", "not-a-uuid", 1, "/scope_id"), ("team", None, 1, "/scope"),
    ("global", None, -1, "/max_instances"), ("global", None, 10001, "/max_instances"), ("global", None, True, "/max_instances"), ("global", None, "2", "/max_instances"),
])
def test_a_quota_that_does_not_fit_is_refused_and_nothing_is_written(rig, scope, scope_id, value, pointer):
    with pytest.raises(InvalidInput) as raised:
        rig.ops.set_quota(ADMIN_SCOPE, scope, scope_id, value)
    assert raised.value.pointer == pointer and rig.quotas.rows() == [] and rig.actions("admin.quota_changed") == []


def test_removing_a_quota_goes_back_to_the_next_level_and_a_missing_one_is_not_found(rig):
    rig.ops.set_quota(ADMIN_SCOPE, "user", LEARNER, 4)
    rig.ops.remove_quota(ADMIN_SCOPE, "user", LEARNER)
    assert rig.quotas.max_instances(LEARNER) == 1 and rig.actions("admin.quota_removed")
    with pytest.raises(NotFound):
        rig.ops.remove_quota(ADMIN_SCOPE, "user", LEARNER)


# ---- capacity and the jobs --------------------------------------------------------------------------------------------------------------------

def test_the_capacity_view_shows_instances_memory_queue_and_failures_and_no_content(rig, sessions):
    with sessions.begin() as s:
        s.add(EmailOutbox(template="system.test", to_user_id=LEARNER, params={}, state="pending", next_attempt_at=T0))
        s.add(EmailOutbox(template="system.test", to_user_id=LEARNER, params={}, state="failed", next_attempt_at=T0))
        s.add(DomainEvent(type="attempt.state_changed", payload={}, created_at=T0))
    view = rig.ops.capacity(ADMIN_SCOPE)
    assert view["instances"] == {"running": 3, "reported": 3, "failed": 1}
    assert view["memory"] == {"capacity_mb": 8192, "used_mb": 2048, "health": "ok"}
    assert view["queue"] == {"emails_waiting": 1, "events_unpublished": 1}
    assert view["failures"] == {"emails_failed": 1, "jobs_failed": 1, "instances_failed": 1}
    assert rig.ops.jobs(ADMIN_SCOPE) == rig.jobs


def test_without_a_lab_the_capacity_view_has_no_host(sessions, companies, audit, clock, ended):
    rig = Rig(sessions, companies, audit, clock, ended)
    bare = AdminOps(sessions=sessions, roles=rig.roles, companies=companies, status=AccountStatusService(sessions, rig.roles, audit), accounts=None, settings=rig.settings,
                    quotas=rig.quotas, audit=audit, records=SqlAttemptRecords(sessions), deletion=None, end_sessions=ended.append, now=clock)
    view = bare.capacity(ADMIN_SCOPE)
    assert view["memory"] is None and view["instances"] == {"running": 0, "reported": 0, "failed": 0} and bare.jobs(ADMIN_SCOPE) == []
