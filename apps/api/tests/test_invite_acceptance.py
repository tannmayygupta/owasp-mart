"""Story P-21 (FR-ASM-04, FR-ASM-05, FR-ASM-06) at service level, on SQLite with the real scoped session and the real attempt engine behind the lab port: opening a link,
accepting (the verified address must match), the consent first, the attempt and the candidate role after it, a decline, a re-invite after a fault, bulk invites, and the
invite purge. The row-level security of the new policy, the races and the migration are in test_invite_acceptance_postgres.py."""
from __future__ import annotations

import re
from datetime import UTC, timedelta

import pytest
from sqlalchemy import select, update
from vulnmart_attempts import AttemptEngine, FakeClock, InMemoryAttemptStore, InMemoryInstanceControl

import vulnmart.assessments.models  # noqa: F401
from test_assessments import ANA, CAND, KEYS, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, ORIGIN, T0, add_admin, audit, clock, companies, ended, entries, org_row, sessions, signup, user_id, verify  # noqa: F401
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import InvalidInput
from vulnmart.assessments.accept import (
    AddressMismatch, InviteAcceptance, InviteConsentTargets, LinkInvalid, NotEligible, attempt_template_key,
)
from vulnmart.assessments.models import Invite
from vulnmart.assessments.service import (
    BULK_MAX, AssessmentService, AlreadyStarted, InviteCapReached, InviteClosed, InviteExists, InviteNotFound, InviteTaken, new_attempt_id,
)
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.fakes import FakeEmailProvider, StaticRecipients
from vulnmart.notifications.service import EmailOutboxService
from vulnmart.notifications.templates import TemplateRenderer
from vulnmart.orgs.service import TermsNotAccepted
from vulnmart.ports.engine_attempts import EngineAttemptPort
from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.lab_fakes import FakeAttemptPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.consent import ConsentService
from vulnmart.privacy.models import ConsentRecord

SCOPE = ContextScopePort()


def participant(sessions, email=CAND, *, verified=True, status="active", account_type="participant", uid=None):
    uid = uid or "u-" + re.sub(r"[^A-Z2-7]", "A", email.upper())[:16].ljust(16, "A")
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email, password_hash="x", display_name="Cand", status=status,
                   email_verified_at=T0 if verified else None))
    return uid


def candidate_scope(uid):
    return Scope(user_id=uid, roles=frozenset({Role.LEARNER}))


class Rig:
    """A company with a template, the acceptance service, the lab port over the real engine and the consent service over the invite targets."""

    def __init__(self, sessions, companies, assessments, audit, clock, attempts=None):
        self.sessions, self.companies, self.audit, self.clock = sessions, companies, audit, clock
        self.engine = AttemptEngine(InMemoryAttemptStore(), InMemoryInstanceControl(), FakeClock(T0))
        self.attempts = attempts or EngineAttemptPort(self.engine)
        self.assessments = AssessmentService(sessions, companies, audit, SCOPE, FakeSettingsPort(), KEYS, public_origin=ORIGIN, now=clock, attempts=self.attempts)
        self.owner = active_company(companies, sessions)
        self.template = self.assessments.create_template(self.owner, basic(retention_days=90))
        self.roles = RoleService(sessions, audit)
        self.accept = InviteAcceptance(assessments, UserDirectory(sessions))
        self.targets = InviteConsentTargets(assessments, self.attempts, self.roles)
        self.consent = ConsentService(sessions, self.targets, audit, FakeSettingsPort(), KEYS, now=clock)

    def invite(self, email=CAND):
        view = self.assessments.create_invite(self.owner, self.template.template_id, email)
        row = mail_rows(self.sessions)[-1]
        return view, token_in(row)

    def decide(self, uid, attempt_id, decision="granted"):
        with SCOPE.acting_as(candidate_scope(uid)):
            n = self.consent.notice(uid, attempt_id)[1]
            return self.consent.record(user_id=uid, attempt_id=attempt_id, notice_version=n.version, notice_sha256=n.sha256, decision=decision, ip="203.0.113.7",
                                       user_agent="Mozilla/5.0 Test")

    def roles_of(self, uid):
        return self.roles.roles_of(uid)


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    return Rig(sessions, companies, assessments, audit, clock)


def row(rig, invite_id):
    """The invite row as its own company sees it."""
    with SCOPE.acting_as(Scope(user_id="system:test", org_id=rig.owner.org_id, roles=frozenset({Role.RECRUITER}))):
        with rig.sessions() as s:
            return s.execute(select(Invite).where(Invite.id == invite_id).execution_options(populate_existing=True)).scalar_one()


# ---- opening the link ----------------------------------------------------------------------------------------------------------------------

def test_opening_the_link_makes_the_invite_opened_and_counts_as_delivered(rig, clock):
    invite, token = rig.invite()
    clock.advance(minutes=3)
    opened = rig.accept.open_link(token)
    assert (opened.state, opened.opened_at, opened.sent_at) == ("opened", clock.now, clock.now)
    again = rig.accept.open_link(token)
    assert again.state == "opened" and again.opened_at == opened.opened_at, "opening twice changes nothing"


def test_a_link_that_opens_nothing_is_none_and_a_closed_invite_is_shown_closed_not_reopened(rig):
    assert rig.accept.open_link("x") is None
    assert rig.accept.open_link("a" * 26 + "." + "A" * 43) is None
    invite, token = rig.invite()
    rig.assessments.cancel(rig.owner, invite.invite_id)
    assert rig.accept.open_link(token).state == "cancelled"


# ---- accepting (FR-ASM-04) -----------------------------------------------------------------------------------------------------------------

def test_a_signed_in_candidate_with_the_matching_verified_address_is_bound_and_gets_the_attempt_id(rig, sessions, audit):
    invite, token = rig.invite()
    uid = participant(sessions)
    got = rig.accept.accept(uid, token)
    assert re.fullmatch(r"a-[A-Z2-7]{16}", got.attempt_id)
    assert (got.invite.state, got.invite.user_id, got.invite.attempt_id, got.invite.generation) == ("opened", uid, got.attempt_id, 1)
    assert rig.accept.accept(uid, token).attempt_id == got.attempt_id, "repeating it gives the same attempt id"
    assert [e for e in entries(audit, "invite.bound")] == [("invite.bound", uid, uid, {"org": rig.owner.org_id, "invite": invite.invite_id, "attempt": got.attempt_id})]


@pytest.mark.parametrize("kwargs", [{"verified": False}, {"status": "disabled"}, {"account_type": "admin"}, {"account_type": "recruiter"}])
def test_an_account_that_is_not_an_active_verified_participant_is_refused(rig, sessions, kwargs):
    _, token = rig.invite()
    uid = participant(sessions, **kwargs)
    with pytest.raises(NotEligible):
        rig.accept.accept(uid, token)
    assert row(rig, rig.accept.open_link(token).invite_id).user_id is None


def test_an_unknown_account_is_not_eligible(rig):
    _, token = rig.invite()
    with pytest.raises(NotEligible):
        rig.accept.accept("u-NOBODYNOBODYNOBO", token)


def test_another_verified_address_is_refused_and_the_answer_does_not_name_the_invited_one(rig, sessions):
    _, token = rig.invite()
    uid = participant(sessions, "someone.else@example.org")
    with pytest.raises(AddressMismatch) as e:
        rig.accept.accept(uid, token)
    assert CAND not in str(e.value) and "candidate" not in repr(e.value)


def test_the_address_is_compared_in_its_canonical_form(rig, sessions):
    _, token = rig.invite("Candidate@Example.ORG")
    uid = participant(sessions, "candidate@example.org")
    assert rig.accept.accept(uid, token).invite.user_id == uid


def test_a_link_that_opens_nothing_is_refused(rig, sessions):
    uid = participant(sessions)
    with pytest.raises(LinkInvalid):
        rig.accept.accept(uid, "not-a-token")


@pytest.mark.parametrize("close", ["cancel", "revoke", "expire"])
def test_a_closed_invite_cannot_be_accepted(rig, sessions, clock, close):
    invite, token = rig.invite()
    uid = participant(sessions)
    if close == "cancel":
        rig.assessments.cancel(rig.owner, invite.invite_id)
    elif close == "revoke":
        rig.accept.open_link(token)
        rig.assessments.revoke(rig.owner, invite.invite_id)
    else:
        clock.advance(days=8)
    with pytest.raises(InviteClosed):
        rig.accept.accept(uid, token)


def test_an_invite_bound_to_one_account_is_never_taken_by_another(rig, sessions):
    invite, token = rig.invite()
    first, second = participant(sessions), participant(sessions, "other@example.org")
    rig.accept.open_link(token)
    rig.assessments.bind_candidate(rig.owner.org_id, invite.invite_id, first)
    with pytest.raises(InviteTaken):
        rig.assessments.bind_candidate(rig.owner.org_id, invite.invite_id, second)
    assert row(rig, invite.invite_id).user_id == first


def test_binding_needs_an_opened_invite(rig, sessions):
    invite, _ = rig.invite()
    with pytest.raises(InviteClosed) as e:
        rig.assessments.bind_candidate(rig.owner.org_id, invite.invite_id, participant(sessions))
    assert e.value.state == "created"
    with pytest.raises(InviteNotFound):
        rig.assessments.bind_candidate(rig.owner.org_id, "i-AAAAAAAAAAAAAAAA", "u-x")


def test_attempt_ids_are_random_and_in_the_contract_format():
    ids = {new_attempt_id() for _ in range(200)}
    assert len(ids) == 200 and all(re.fullmatch(r"a-[A-Z2-7]{16}", i) for i in ids)


# ---- the consent first, then the attempt ---------------------------------------------------------------------------------------------------

def test_consent_comes_first_the_notice_shows_the_template_retention_and_a_grant_creates_the_attempt_and_the_role(rig, sessions, audit):
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    assert rig.roles_of(uid) == frozenset(), "accepting alone gives no role and creates no attempt"
    with pytest.raises(Exception):
        rig.attempts.get(attempt_id)
    with SCOPE.acting_as(candidate_scope(uid)):
        target, notice = rig.consent.notice(uid, attempt_id)
    assert (target.state, target.company_name, target.retention_days) == ("consent", "Acme", 90)
    assert notice.retention_days_shown == 90, "the template's retention, not the platform default, is what the candidate is told"
    record = rig.decide(uid, attempt_id)
    assert record.decision == "granted" and record.attempt_id == attempt_id
    assert row(rig, invite.invite_id).state == "consented"
    attempt = rig.attempts.get(attempt_id)
    assert (attempt.user_id, attempt.org_id, attempt.state.value, attempt.consent_id) == (uid, rig.owner.org_id, "ready", record.consent_id)
    assert attempt.template_id == rig.template.template_id
    assert "candidate" in rig.roles_of(uid)
    assert [e[0] for e in entries(audit) if e[0].startswith(("invite.", "consent.", "role."))][-4:] == ["invite.bound", "consent.granted", "invite.consented", "role.granted"]


def test_a_decline_ends_the_invite_creates_nothing_and_gives_no_role(rig, sessions):
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    record = rig.decide(uid, attempt_id, "declined")
    assert record.decision == "declined"
    declined = row(rig, invite.invite_id)
    assert (declined.state, declined.closed_at.replace(tzinfo=UTC)) == ("declined", T0)
    with pytest.raises(Exception):
        rig.attempts.get(attempt_id)
    assert rig.roles_of(uid) == frozenset()
    with pytest.raises(InviteClosed):
        rig.accept.accept(uid, token)


def test_repeating_the_grant_changes_nothing(rig, sessions):
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    first = rig.decide(uid, attempt_id)
    with SCOPE.acting_as(candidate_scope(uid)):
        again = rig.consent.record(user_id=uid, attempt_id=attempt_id, notice_version=first and "x", notice_sha256="y", decision="granted", ip=None, user_agent=None)
    assert again.consent_id == first.consent_id
    assert row(rig, invite.invite_id).state == "consented"
    with sessions() as s:
        assert len(s.scalars(select(ConsentRecord)).all()) == 1


def test_a_failure_between_the_invite_move_and_the_attempt_is_finished_by_repeating_the_request(rig, sessions):
    class Flaky(FakeAttemptPort):
        fail = 1

        def create_from_consent(self, **kw):
            if self.fail:
                self.fail -= 1
                raise RuntimeError("lab down")
            return super().create_from_consent(**kw)

    flaky = Flaky()
    rig.targets = InviteConsentTargets(rig.assessments, flaky, rig.roles)
    rig.consent = ConsentService(sessions, rig.targets, rig.audit, FakeSettingsPort(), KEYS, now=rig.clock)
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    with pytest.raises(RuntimeError):
        rig.decide(uid, attempt_id)
    assert row(rig, invite.invite_id).state == "consented" and "candidate" not in rig.roles_of(uid)
    with SCOPE.acting_as(candidate_scope(uid)):
        rig.consent.record(user_id=uid, attempt_id=attempt_id, notice_version="", notice_sha256="", decision="granted", ip=None, user_agent=None)
    assert flaky.get(attempt_id).state.value == "ready" and "candidate" in rig.roles_of(uid)


def test_the_attempt_is_not_made_when_the_invite_was_revoked_after_the_decision_was_recorded(rig, sessions):
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    rig.assessments.revoke(rig.owner, invite.invite_id)
    with SCOPE.acting_as(candidate_scope(uid)):
        with pytest.raises(Exception):
            rig.consent.notice(uid, attempt_id)  # no longer in consent: the screen is refused
    with SCOPE.acting_as(candidate_scope(uid)):
        with pytest.raises(InviteClosed):
            rig.targets.proceed(attempt_id, decision="granted", consent_id="k-AAAAAAAAAAAAAAAA")
    with pytest.raises(Exception):
        rig.attempts.get(attempt_id)


def test_only_the_bound_candidate_finds_the_attempt(rig, sessions):
    _, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    other = participant(sessions, "other@example.org")
    with SCOPE.acting_as(candidate_scope(other)):
        assert rig.targets.find(attempt_id) is None, "someone else's attempt is answered like a missing one"
    with SCOPE.acting_as(candidate_scope(uid)):
        assert rig.targets.find(attempt_id).user_id == uid
        assert rig.targets.find("a-AAAAAAAAAAAAAAAA") is None
    with pytest.raises(ScopeMissing):
        rig.targets.find(attempt_id)


def test_an_unbound_invite_has_no_attempt_to_find(rig):
    _, token = rig.invite()
    rig.accept.open_link(token)
    with SCOPE.acting_as(candidate_scope("u-AAAAAAAAAAAAAAAA")):
        assert rig.targets.find("a-AAAAAAAAAAAAAAAA") is None


def test_the_invite_states_map_to_the_attempt_states_the_consent_routes_know(rig, sessions):
    invite, token = rig.invite()
    uid = participant(sessions)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    seen = []
    for step in (None, "consented", "started"):
        if step:
            rig.assessments.advance(rig.owner.org_id, invite.invite_id, step)
        with SCOPE.acting_as(candidate_scope(uid)):
            seen.append(rig.targets.find(attempt_id).state)
    assert seen == ["consent", "ready", "running"]


# ---- re-invite after a fault (FR-ASM-05) --------------------------------------------------------------------------------------------------

def accepted(rig, sessions, email=CAND):
    invite, token = rig.invite(email)
    uid = participant(sessions, email) if rig.sessions is sessions and not _exists(sessions, email) else _uid(sessions, email)
    attempt_id = rig.accept.accept(uid, token).attempt_id
    rig.decide(uid, attempt_id)
    return invite, uid, attempt_id


def _exists(sessions, email):
    with sessions() as s:
        return s.scalar(select(User.id).where(User.email_ci == email)) is not None


def _uid(sessions, email):
    with sessions() as s:
        return s.scalar(select(User.id).where(User.email_ci == email))


def test_a_reinvite_after_a_fault_makes_a_new_attempt_marks_the_old_one_and_cancels_it(rig, sessions, audit):
    old, uid, old_attempt = accepted(rig, sessions)
    new = rig.assessments.reinvite(rig.owner, old.invite_id)
    assert (new.generation, new.supersedes_attempt_id, new.state, new.email) == (2, old_attempt, "created", CAND)
    old_row = row(rig, old.invite_id)
    assert (old_row.state, old_row.superseded_by) == ("revoked", new.invite_id), "a consented invite is revoked so its link cannot start a second attempt"
    assert rig.attempts.get(old_attempt).state.value == "cancelled"
    assert entries(audit, "invite.superseded") == [("invite.superseded", rig.owner.user_id, None, {"org": rig.owner.org_id, "invite": old.invite_id, "replaced_by": new.invite_id})]
    token = token_in(mail_rows(sessions)[-1])
    again = rig.accept.accept(uid, token)
    assert again.attempt_id != old_attempt
    rig.decide(uid, again.attempt_id)
    fresh = rig.attempts.get(again.attempt_id)
    assert fresh.state.value == "ready" and fresh.user_id == uid
    assert fresh.template_id == attempt_template_key(rig.template.template_id, 2) == f"{rig.template.template_id}~2"
    assert rig.attempts.get(old_attempt).state.value == "cancelled", "the old attempt stays cancelled"


def test_a_reinvite_of_a_started_invite_keeps_it_as_started_and_names_the_successor(rig, sessions):
    old, uid, old_attempt = accepted(rig, sessions)
    rig.assessments.advance(rig.owner.org_id, old.invite_id, "started")
    new = rig.assessments.reinvite(rig.owner, old.invite_id)
    old_row = row(rig, old.invite_id)
    assert (old_row.state, old_row.superseded_by, old_row.started_at is not None) == ("started", new.invite_id, True)
    assert new.generation == 2 and new.supersedes_attempt_id == old_attempt


def test_generations_count_up_and_the_chain_is_kept(rig, sessions):
    first, uid, a1 = accepted(rig, sessions)
    second = rig.assessments.reinvite(rig.owner, first.invite_id)
    token = token_in(mail_rows(sessions)[-1])
    a2 = rig.accept.accept(uid, token).attempt_id
    rig.decide(uid, a2)
    third = rig.assessments.reinvite(rig.owner, second.invite_id)
    assert (second.generation, third.generation, third.supersedes_attempt_id) == (2, 3, a2)
    assert row(rig, second.invite_id).superseded_by == third.invite_id


def test_only_an_invite_that_was_consented_to_or_started_can_be_reinvited_and_only_once(rig, sessions):
    invite, token = rig.invite()
    for state in ("created",):
        with pytest.raises(InviteClosed) as e:
            rig.assessments.reinvite(rig.owner, invite.invite_id)
        assert e.value.state == state
    rig.accept.open_link(token)
    with pytest.raises(InviteClosed):
        rig.assessments.reinvite(rig.owner, invite.invite_id)
    done, uid, _ = accepted(rig, sessions, "second@example.org")
    rig.assessments.reinvite(rig.owner, done.invite_id)
    with pytest.raises(InviteClosed):
        rig.assessments.reinvite(rig.owner, done.invite_id)
    with pytest.raises(InviteNotFound):
        rig.assessments.reinvite(rig.owner, "i-AAAAAAAAAAAAAAAA")


def test_a_refused_reinvite_leaves_the_old_invite_and_attempt_untouched(rig, sessions, companies):
    old, uid, old_attempt = accepted(rig, sessions)
    companies.set_invite_cap(ADMIN_SCOPE, rig.owner.org_id, 1)  # the first invite used it up today
    with pytest.raises(InviteCapReached):
        rig.assessments.reinvite(rig.owner, old.invite_id)
    old_row = row(rig, old.invite_id)
    assert (old_row.state, old_row.superseded_by) == ("consented", None)
    assert rig.attempts.get(old_attempt).state.value == "ready"


def test_a_reinvite_counts_against_the_daily_cap_and_needs_the_terms(rig, sessions, companies):
    old, uid, _ = accepted(rig, sessions)
    companies.set_invite_cap(ADMIN_SCOPE, rig.owner.org_id, 2)
    rig.assessments.reinvite(rig.owner, old.invite_id)
    with pytest.raises(InviteCapReached):
        rig.invite("another@example.org")


def test_a_second_attempt_on_the_same_template_is_only_by_reinvite(rig, sessions):
    old, uid, _ = accepted(rig, sessions)
    rig.assessments.advance(rig.owner.org_id, old.invite_id, "started")
    with pytest.raises(AlreadyStarted):
        rig.assessments.create_invite(rig.owner, rig.template.template_id, CAND)
    rig.assessments.reinvite(rig.owner, old.invite_id)
    with pytest.raises(InviteExists):
        rig.assessments.create_invite(rig.owner, rig.template.template_id, CAND)


def test_a_reinvite_takes_the_rules_of_the_template_as_they_are_now(rig, sessions):
    old, uid, _ = accepted(rig, sessions)
    rig.assessments.update_template(rig.owner, rig.template.template_id, basic(retention_days=45, time_limit_min=60))
    new = rig.assessments.reinvite(rig.owner, old.invite_id)
    assert (new.rules["retention_days"], new.rules["time_limit_min"], old.rules["retention_days"]) == (45, 60, 90)


def test_another_company_cannot_reinvite(rig, sessions, companies, assessments):
    old, uid, _ = accepted(rig, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    t = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, t.version, t.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    with pytest.raises(InviteNotFound):
        assessments.reinvite(dee, old.invite_id)


def test_a_reinvite_works_when_the_lab_cannot_cancel_the_old_attempt(rig, sessions):
    old, uid, old_attempt = accepted(rig, sessions)
    rig.engine.cancel(old_attempt, "recruiter", "cancelled")  # already cancelled by someone else: the port refuses a second cancel
    new = rig.assessments.reinvite(rig.owner, old.invite_id)
    assert new.generation == 2


def test_the_attempt_key_of_the_first_generation_is_the_template_itself():
    assert attempt_template_key("t", 1) == "t" and attempt_template_key("t", 2) == "t~2" and attempt_template_key("t", 5) == "t~5"


# ---- bulk invites (FR-ASM-06) --------------------------------------------------------------------------------------------------------------

def test_a_bulk_invite_makes_one_invite_and_one_mail_per_address_and_reports_the_rest(rig, sessions):
    emails = ["a@example.org", "B@Example.org", "not-an-address", "a@example.org", "  ", "c@example.org", "b@example.org"]
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, emails)
    assert [v.email for v in result.created] == ["a@example.org", "b@example.org", "c@example.org"]
    assert result.skipped == (("not-an-address", "invalid"), ("a@example.org", "duplicate"), ("  ", "invalid"), ("b@example.org", "duplicate"))
    assert result.remaining == () and result.cap is None
    rows = mail_rows(sessions)
    assert len(rows) == 3 and len({token_in(r) for r in rows}) == 3, "every address has its own token"
    assert all(v.state == "created" for v in result.created)


def test_a_bulk_invite_skips_addresses_that_already_have_a_live_or_started_invite(rig, sessions):
    live, _ = rig.invite("live@example.org")
    old, uid, _ = accepted(rig, sessions)
    rig.assessments.advance(rig.owner.org_id, old.invite_id, "started")
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, ["live@example.org", CAND, "new@example.org"])
    assert result.skipped == (("live@example.org", "exists"), (CAND, "started"))
    assert [v.email for v in result.created] == ["new@example.org"]


def test_at_the_daily_cap_a_bulk_invite_stops_and_hands_back_what_it_did_not_reach(rig, sessions, companies, clock):
    companies.set_invite_cap(ADMIN_SCOPE, rig.owner.org_id, 3)
    emails = [f"p{i}@example.org" for i in range(7)] + ["bad", "p1@example.org"]
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, emails)
    assert [v.email for v in result.created] == ["p0@example.org", "p1@example.org", "p2@example.org"]
    assert result.cap == 3 and result.remaining == tuple(f"p{i}@example.org" for i in range(3, 7))
    assert result.skipped == (), "the bad address and the repeat come after the cap: they were not looked at"
    assert len(mail_rows(sessions)) == 3, "nothing was queued past the cap"
    clock.advance(days=1)
    next_day = rig.assessments.create_invites(rig.owner, rig.template.template_id, list(result.remaining))
    assert [v.email for v in next_day.created] == list(result.remaining[:3]) and next_day.remaining == ("p6@example.org",), "a new day, another three: still nothing lost"
    clock.advance(days=1)
    last = rig.assessments.create_invites(rig.owner, rig.template.template_id, list(next_day.remaining))
    assert [v.email for v in last.created] == ["p6@example.org"] and last.remaining == () and last.cap is None


def test_a_bulk_invite_of_nothing_or_too_many_or_the_wrong_shape_is_refused(rig):
    for bad in ([], ["a@example.org"] * (BULK_MAX + 1), "a@example.org", [1, 2], None):
        with pytest.raises(InvalidInput) as e:
            rig.assessments.create_invites(rig.owner, rig.template.template_id, bad)
        assert e.value.pointer == "/emails"
    assert len(mail_rows(rig.sessions)) == 0


def test_a_list_of_the_maximum_size_is_taken_and_the_default_cap_of_the_day_decides_how_much_of_it_is_made(rig, sessions):
    emails = [f"u{i}@example.org" for i in range(BULK_MAX)]
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, emails)
    assert len(result.created) == 50 and result.cap == 50 and result.remaining == tuple(emails[50:])


def test_a_bulk_invite_needs_the_terms_and_an_active_recruiter(sessions, companies, assessments):
    owner = active_company(companies, sessions, terms=False)
    template = assessments.create_template(owner, basic())
    with pytest.raises(TermsNotAccepted):
        assessments.create_invites(owner, template.template_id, ["a@example.org"])


def test_the_providers_daily_cap_delays_the_bulk_mail_in_order_and_all_of_it_is_sent_in_the_end(rig, sessions, clock):
    with sessions.begin() as s:  # the signup and approval mails of the company are not what this is about: they left long ago
        s.execute(update(EmailOutbox).values(state="sent", sent_at=T0 - timedelta(days=5)))
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, [f"p{i}@example.org" for i in range(5)])
    assert len(result.created) == 5
    provider = FakeEmailProvider()
    outbox = EmailOutboxService(sessions, provider, StaticRecipients({}), TemplateRenderer(), FakeSettingsPort({"email_daily_cap": 2}), now=clock,
                                address_opener=lambda sealed, aad: KEYS.open(sealed, account=aad))
    sent_by_day = []
    for _ in range(4):
        for outbox_id in outbox.claim_due():
            outbox.deliver(outbox_id)
        sent_by_day.append(len(provider.sent))
        clock.advance(days=1)
    assert sent_by_day == [2, 4, 5, 5], "two a day, in the order they were made"
    assert [m.to for m in provider.sent] == [f"p{i}@example.org" for i in range(5)]


# ---- the invite purge can see closed invites (story P-24 uses it) -------------------------------------------------------------------------

def test_the_purge_empties_the_token_of_closed_invites_only_and_a_purged_link_opens_nothing(rig, sessions, clock):
    kept, kept_token = rig.invite("kept@example.org")
    cancelled, c_token = rig.invite("cancelled@example.org")
    rig.assessments.cancel(rig.owner, cancelled.invite_id)
    revoked, r_token = rig.invite("revoked@example.org")
    rig.accept.open_link(r_token)
    rig.assessments.revoke(rig.owner, revoked.invite_id)
    expired, e_token = rig.invite("expired@example.org")
    declined, d_token = rig.invite("declined@example.org")
    uid = participant(sessions, "declined@example.org")
    rig.decide(uid, rig.accept.accept(uid, d_token).attempt_id, "declined")
    assert rig.assessments.purge_closed_tokens(T0 + timedelta(days=30)) == 3, "cancelled, revoked, declined: not the live one, not the one not yet expired"
    for gone, token in ((cancelled, c_token), (revoked, r_token), (declined, d_token)):
        assert row(rig, gone.invite_id).token_hash is None
        assert rig.accept.open_link(token) is None
    assert row(rig, kept.invite_id).token_hash is not None and rig.accept.open_link(kept_token).state == "opened"


def test_the_purge_sees_invites_expired_by_expire_all_and_respects_the_cutoff(rig, sessions, clock):
    stale, token = rig.invite("stale@example.org")
    clock.advance(days=8)
    assert rig.assessments.expire_all() == 1
    assert rig.assessments.purge_closed_tokens(T0) == 0, "closed after the cutoff: kept"
    assert rig.assessments.purge_closed_tokens(clock.now) == 1
    assert row(rig, stale.invite_id).state == "expired" and row(rig, stale.invite_id).token_hash is None
    assert rig.assessments.purge_closed_tokens(clock.now) == 0, "nothing left to empty"
    assert rig.accept.open_link(token) is None


def test_the_purge_reaches_every_company(rig, sessions, companies, assessments, clock):
    mine, _ = rig.invite("mine@example.org")
    rig.assessments.cancel(rig.owner, mine.invite_id)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    t = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, t.version, t.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    theirs = assessments.create_invite(dee, assessments.create_template(dee, basic()).template_id, "x@example.org")
    assessments.cancel(dee, theirs.invite_id)
    assert assessments.purge_closed_tokens(clock.now + timedelta(days=1)) == 2
