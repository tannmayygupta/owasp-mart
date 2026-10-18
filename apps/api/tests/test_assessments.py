"""Story P-20 (FR-ASM-01, FR-ASM-02, FR-ASM-03) at service level, on SQLite with the real scoped session: assessment templates, creating and sending invites, the invite
lifecycle, the token, and what stays inside a company. The row-level security and the races are in test_assessments_postgres.py."""
from __future__ import annotations

import re
from datetime import timedelta

import pytest
from sqlalchemy import select, update

import vulnmart.assessments.models  # noqa: F401
from test_companies import ADMIN_SCOPE, ORIGIN, T0, add_admin, audit, clock, companies, ended, entries, org_row, sessions, signup, user_id, verify  # noqa: F401
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.accounts.service import InvalidInput
from vulnmart.assessments import tokens
from vulnmart.assessments.models import AssessmentTemplate, Invite, TemplateChallenge
from vulnmart.assessments.service import (
    EDGES, AssessmentService, InviteCapReached, InviteClosed, InviteExists, InviteNotFound, TemplateInUse, TemplateNotFound, validate_template,
)
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.notifications.models import EmailOutbox
from vulnmart.orgs.service import NotActiveRecruiter, TermsNotAccepted
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
ANA = "ana@acme.example"
CAND = "candidate@example.org"
KEYS_OK = ["C01", "C02", "C05"]


@pytest.fixture
def assessments(sessions, companies, audit, clock):
    return AssessmentService(sessions, companies, audit, ContextScopePort(), FakeSettingsPort(), KEYS, public_origin=ORIGIN, now=clock)


def active_company(companies, sessions, *, email=ANA, company="Acme", name="Ana Owner", terms=True):
    """An approved company whose owner accepted the terms (or not); returns the owner's session scope."""
    add_admin(sessions)
    signup(companies, email=email, company=company, name=name)
    verify(sessions, email)
    uid = user_id(sessions, email)
    org_id = str(org_row(sessions, email).id)
    companies.approve(ADMIN_SCOPE, org_id)
    if terms:
        t = companies.terms_for(uid)
        companies.accept_terms(uid, t.version, t.sha256)
    return Scope(user_id=uid, org_id=org_id, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))


def basic(**over):
    return {"title": "Web security, junior", "challenge_keys": KEYS_OK, **over}


def mail_rows(sessions):
    with sessions() as s:
        return list(s.scalars(select(EmailOutbox).where(EmailOutbox.template == "candidate.invite").order_by(EmailOutbox.id)))


def token_in(row) -> str:
    return re.search(r"token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})", row.params["link"]).group(1)


# ---- the token -----------------------------------------------------------------------------------------------------------------------------

def test_a_token_names_its_company_hashes_to_64_hex_and_is_random():
    import uuid

    org = uuid.uuid4()
    seen = {tokens.new_token(org) for _ in range(300)}
    assert len(seen) == 300
    for t in list(seen)[:20]:
        assert tokens.TOKEN.match(t) and tokens.org_of(t) == org and re.fullmatch(r"[0-9a-f]{64}", tokens.hash_token(t)) and tokens.hash_token(t) != t
    assert tokens.hash_token("a") != tokens.hash_token("b")


@pytest.mark.parametrize("bad", ["", "x", "nodot", "A" * 26 + "." + "a" * 43, "a" * 26 + "." + "a" * 42, "a" * 25 + "." + "a" * 43, "a" * 26 + "." + "a" * 43 + "x",
                                 "a" * 26 + ".!" + "a" * 42, "11111111111111111111111111." + "a" * 43])
def test_a_malformed_token_names_no_company(bad):
    assert tokens.org_of(bad) is None


# ---- templates (FR-ASM-01) -----------------------------------------------------------------------------------------------------------------

def test_a_template_starts_from_the_defaults_of_the_requirement(assessments, companies, sessions, audit):
    owner = active_company(companies, sessions)
    view = assessments.create_template(owner, basic())
    assert (view.time_limit_min, view.hints_mode, view.hint_cost_pct, view.reset_limit, view.invite_expiry_days, view.retention_days) == (120, "off", 0, 3, 7, 180)
    assert (view.writeup_required, view.results_visibility, view.flag_submissions_per_minute, view.version) == (False, "after_submit", 10, 1), "OI-14 and OI-15 defaults"
    assert view.challenge_keys == ("C01", "C02", "C05") and view.title == "Web security, junior"
    assert entries(audit, "template.created")[0][:3] == ("template.created", owner.user_id, owner.user_id)
    assert assessments.get_template(owner, view.template_id) == view and assessments.list_templates(owner) == [view]


def test_a_template_takes_every_field_the_requirement_names(assessments, companies, sessions):
    owner = active_company(companies, sessions)
    view = assessments.create_template(owner, basic(time_limit_min=45, hints_mode="on", hint_cost_pct=35, reset_limit=0, invite_expiry_days=30, retention_days=365,
                                                    writeup_required=True, results_visibility="after_release", flag_submissions_per_minute=60,
                                                    challenge_keys=[f"C{n:02d}" for n in range(11, 0, -1)]))
    assert (view.time_limit_min, view.hints_mode, view.hint_cost_pct, view.reset_limit, view.invite_expiry_days, view.retention_days) == (45, "on", 35, 0, 30, 365)
    assert (view.writeup_required, view.results_visibility, view.flag_submissions_per_minute) == (True, "after_release", 60)
    assert view.challenge_keys == tuple(f"C{n:02d}" for n in range(1, 12)), "any of the 11"


@pytest.mark.parametrize("values,pointer,kind", [
    ({"title": ""}, "/title", "value_error"), ({"title": "  "}, "/title", "value_error"), ({"title": "x" * 121}, "/title", "value_error"), ({"title": 5}, "/title", "value_error"),
    ({"challenge_keys": []}, "/challenge_keys", "unknown_challenge"), ({"challenge_keys": ["C12"]}, "/challenge_keys", "unknown_challenge"),
    ({"challenge_keys": ["C01", "C01"]}, "/challenge_keys", "unknown_challenge"), ({"challenge_keys": "C01"}, "/challenge_keys", "unknown_challenge"),
    ({"time_limit_min": 29}, "/time_limit_min", "out_of_range"), ({"time_limit_min": 481}, "/time_limit_min", "out_of_range"), ({"time_limit_min": True}, "/time_limit_min", "out_of_range"),
    ({"time_limit_min": "120"}, "/time_limit_min", "out_of_range"), ({"hints_mode": "maybe"}, "/hints_mode", "value_error"),
    ({"hints_mode": "off", "hint_cost_pct": 10}, "/hint_cost_pct", "out_of_range"), ({"hints_mode": "on", "hint_cost_pct": 101}, "/hint_cost_pct", "out_of_range"),
    ({"hints_mode": "on", "hint_cost_pct": -1}, "/hint_cost_pct", "out_of_range"), ({"reset_limit": -1}, "/reset_limit", "out_of_range"), ({"reset_limit": 11}, "/reset_limit", "out_of_range"),
    ({"invite_expiry_days": 0}, "/invite_expiry_days", "out_of_range"), ({"invite_expiry_days": 31}, "/invite_expiry_days", "out_of_range"),
    ({"retention_days": 29}, "/retention_days", "out_of_range"), ({"retention_days": 366}, "/retention_days", "out_of_range"),
    ({"flag_submissions_per_minute": 0}, "/flag_submissions_per_minute", "out_of_range"), ({"flag_submissions_per_minute": 61}, "/flag_submissions_per_minute", "out_of_range"),
    ({"writeup_required": "yes"}, "/writeup_required", "value_error"), ({"results_visibility": "never"}, "/results_visibility", "value_error"),
    ({"surprise": 1}, "/surprise", "unknown_member"),
])
def test_a_bad_template_is_refused_naming_the_field(values, pointer, kind):
    with pytest.raises(InvalidInput) as e:
        validate_template(basic(**values))
    assert (e.value.pointer, e.value.kind) == (pointer, kind)


@pytest.mark.parametrize("name", ["flags", "flags_enabled", "per_instance_flags", "evidence", "evidence_capture", "audit", "audit_log", "consent", "consent_screen"])
def test_what_cannot_be_switched_off_is_refused_as_such(name):
    for value in (False, True, 0):
        with pytest.raises(InvalidInput) as e:
            validate_template(basic(**{name: value}))
        assert (e.value.pointer, e.value.kind) == (f"/{name}", "cannot_be_switched_off")


def test_a_template_needs_a_title_and_challenges():
    with pytest.raises(InvalidInput):
        validate_template({"challenge_keys": KEYS_OK})
    with pytest.raises(InvalidInput):
        validate_template({"title": "T"})


def test_editing_a_template_changes_the_template_but_not_an_invite_already_made(assessments, companies, sessions):
    owner = active_company(companies, sessions)
    view = assessments.create_template(owner, basic(time_limit_min=60))
    invite = assessments.create_invite(owner, view.template_id, CAND)
    edited = assessments.update_template(owner, view.template_id, basic(time_limit_min=240, challenge_keys=["C03"], title="Changed"))
    assert (edited.version, edited.time_limit_min, edited.challenge_keys, edited.title) == (2, 240, ("C03",), "Changed")
    assert assessments.get_invite(owner, invite.invite_id).rules["time_limit_min"] == 60, "the invite keeps the rules it was made with (FR-ASM-01)"
    assert assessments.get_invite(owner, invite.invite_id).rules["challenge_keys"] == KEYS_OK and assessments.get_invite(owner, invite.invite_id).rules["template_version"] == 1
    later = assessments.create_invite(owner, view.template_id, "second@example.org")
    assert later.rules["time_limit_min"] == 240 and later.rules["template_version"] == 2


def test_templates_are_a_companys_own(assessments, companies, sessions):
    ana = active_company(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, "dee@other.example").id))
    dee_id = user_id(sessions, "dee@other.example")
    dee = Scope(user_id=dee_id, org_id=str(org_row(sessions, "dee@other.example").id), roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    mine = assessments.create_template(ana, basic())
    assert assessments.list_templates(dee) == []
    for call in (lambda: assessments.get_template(dee, mine.template_id), lambda: assessments.update_template(dee, mine.template_id, basic()),
                 lambda: assessments.delete_template(dee, mine.template_id), lambda: assessments.create_invite(dee, mine.template_id, CAND)):
        with pytest.raises((TemplateNotFound, TermsNotAccepted)):
            call()
    assert assessments.get_template(ana, mine.template_id).title == mine.title


def test_a_template_with_invites_cannot_be_deleted_and_one_without_can(assessments, companies, sessions, audit):
    owner = active_company(companies, sessions)
    used, spare = assessments.create_template(owner, basic()), assessments.create_template(owner, basic(title="Spare"))
    assessments.create_invite(owner, used.template_id, CAND)
    with pytest.raises(TemplateInUse):
        assessments.delete_template(owner, used.template_id)
    assessments.delete_template(owner, spare.template_id)
    assert [t.title for t in assessments.list_templates(owner)] == ["Web security, junior"]
    with pytest.raises(TemplateNotFound):
        assessments.get_template(owner, spare.template_id)
    assert entries(audit, "template.deleted")[0][3]["template"] == spare.template_id
    with pytest.raises(TemplateNotFound):
        assessments.get_template(owner, "not-a-uuid")


def test_the_template_routes_need_an_active_recruiter_of_an_active_company(assessments, companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    verify(sessions, ANA)
    pending = Scope(user_id=user_id(sessions, ANA), org_id=str(org_row(sessions, ANA).id), roles=frozenset({Role.RECRUITER}))
    for scope in (pending, Scope(user_id=pending.user_id, org_id=None, roles=frozenset({Role.RECRUITER})), Scope(user_id=pending.user_id, org_id=pending.org_id)):
        with pytest.raises(NotActiveRecruiter):
            assessments.create_template(scope, basic())
        with pytest.raises(NotActiveRecruiter):
            assessments.list_templates(scope)


def test_a_company_in_the_scope_that_is_not_the_recruiters_own_is_refused(assessments, companies, sessions):
    ana = active_company(companies, sessions)
    other_company = "00000000-0000-4000-8000-000000000000"
    forged = Scope(user_id=ana.user_id, org_id=other_company, roles=ana.roles)
    with pytest.raises(NotActiveRecruiter):
        assessments.create_template(forged, basic())


# ---- creating and sending invites (FR-ASM-02) ---------------------------------------------------------------------------------------------

def test_an_invite_keeps_only_the_hash_of_a_256_bit_token_bound_to_the_address_and_the_mail_carries_the_link(assessments, companies, sessions, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, "  Candidate@Example.ORG ")
    assert re.fullmatch(r"i-[A-Z2-7]{16}", invite.invite_id) and invite.email == "candidate@example.org" and invite.state == "created"
    assert invite.expires_at == T0 + timedelta(days=7) and invite.rules["template_version"] == 1
    [mail] = mail_rows(sessions)
    token = token_in(mail)
    assert mail.template == "candidate.invite" and mail.to_user_id == invite.invite_id and mail.state == "pending"
    assert mail.params["link"] == f"{ORIGIN}/invite?token={token}" and mail.params["org_name"] == "Acme" and mail.params["assessment_name"] == "Web security, junior"
    assert mail.params["expires_in_days"] == 7 and "@" not in str(mail.params), "no address in the params"
    assert mail.to_address_sealed and "@" not in mail.to_address_sealed and "candidate" not in mail.to_address_sealed
    assert KEYS.open(mail.to_address_sealed, account=invite.invite_id) == "candidate@example.org", "sealed with the field key and bound to the invite"
    with pytest.raises(Exception):
        KEYS.open(mail.to_address_sealed, account="i-SOMETHINGELSEXXXX")
    with ContextScopePort().acting_as(owner):
        with sessions() as s:
            row = s.get(Invite, invite.invite_id)
    assert row.token_hash == tokens.hash_token(token) and row.token_hash != token and token not in str(row.__dict__) and row.outbox_id == mail.id
    assert tokens.org_of(token).hex == owner.org_id.replace("-", "")
    [entry] = entries(audit, "invite.created")
    assert entry[1] == owner.user_id and entry[2] is None and entry[3] == {"org": owner.org_id, "invite": invite.invite_id, "template": template.template_id}
    assert "example.org" not in str(entries(audit)) and token not in str(entries(audit)), "no address and no token in the audit log"


def test_an_invite_needs_the_terms_an_active_company_a_real_template_and_a_valid_address(assessments, companies, sessions):
    owner = active_company(companies, sessions, terms=False)
    template = assessments.create_template(owner, basic())  # templates need no terms
    with pytest.raises(TermsNotAccepted):
        assessments.create_invite(owner, template.template_id, CAND)
    t = companies.terms_for(owner.user_id)
    companies.accept_terms(owner.user_id, t.version, t.sha256)
    for email in ("", "not an address", "a@b", "x" * 300 + "@example.org"):
        with pytest.raises(InvalidInput) as e:
            assessments.create_invite(owner, template.template_id, email)
        assert e.value.pointer == "/email"
    for tid in ("not-a-uuid", "00000000-0000-4000-8000-000000000000"):
        with pytest.raises(TemplateNotFound):
            assessments.create_invite(owner, tid, CAND)
    assert mail_rows(sessions) == []


def test_a_second_live_invite_for_the_same_address_and_template_is_refused_until_the_first_is_closed(assessments, companies, sessions):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    first = assessments.create_invite(owner, template.template_id, CAND)
    with pytest.raises(InviteExists):
        assessments.create_invite(owner, template.template_id, "CANDIDATE@example.org")
    other = assessments.create_template(owner, basic(title="Another"))
    assert assessments.create_invite(owner, other.template_id, CAND).invite_id != first.invite_id, "another template is another invite"
    assessments.cancel(owner, first.invite_id)
    second = assessments.create_invite(owner, template.template_id, CAND)
    assert second.invite_id != first.invite_id and second.state == "created", "a re-issue is a new invite"
    assert assessments.get_invite(owner, first.invite_id).state == "cancelled"


def test_the_daily_cap_counts_invites_refuses_the_next_and_keeps_the_others(assessments, companies, sessions, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    companies.set_invite_cap(ADMIN_SCOPE, owner.org_id, 2)
    first = assessments.create_invite(owner, template.template_id, "a@example.org")
    second = assessments.create_invite(owner, template.template_id, "b@example.org")
    with pytest.raises(InviteCapReached) as e:
        assessments.create_invite(owner, template.template_id, "c@example.org")
    assert (e.value.cap, e.value.remaining) == (2, 0)
    assert {i.invite_id for i in assessments.list_invites(owner)} == {first.invite_id, second.invite_id}
    assert len(mail_rows(sessions)) == 2, "nothing was queued for the refused one"
    clock.advance(days=1)
    assert assessments.create_invite(owner, template.template_id, "c@example.org").state == "created", "a new day, a new cap"
    companies.set_invite_cap(ADMIN_SCOPE, owner.org_id, 0)
    with pytest.raises(InviteCapReached):
        assessments.create_invite(owner, template.template_id, "d@example.org")
    companies.set_invite_cap(ADMIN_SCOPE, owner.org_id, None)
    assert assessments.create_invite(owner, template.template_id, "d@example.org")


def test_the_cap_is_per_company(assessments, companies, sessions):
    ana = active_company(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    t = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, t.version, t.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    companies.set_invite_cap(ADMIN_SCOPE, ana.org_id, 1)
    ta, td = assessments.create_template(ana, basic()), assessments.create_template(dee, basic())
    assessments.create_invite(ana, ta.template_id, "a@example.org")
    with pytest.raises(InviteCapReached):
        assessments.create_invite(ana, ta.template_id, "b@example.org")
    assert assessments.create_invite(dee, td.template_id, "a@example.org"), "Ana's cap does not limit Dee"


# ---- the lifecycle (FR-ASM-03) ------------------------------------------------------------------------------------------------------------

def deliver(sessions, outbox_id, at):
    with sessions.begin() as s:
        s.execute(update(EmailOutbox).where(EmailOutbox.id == outbox_id).values(state="sent", sent_at=at, to_address_sealed=None))


def test_sent_is_read_from_the_queued_mail_when_the_invite_is_read(assessments, companies, sessions, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    assert assessments.get_invite(owner, invite.invite_id).state == "created"
    clock.advance(minutes=3)
    deliver(sessions, mail_rows(sessions)[0].id, clock.now)
    seen = assessments.get_invite(owner, invite.invite_id)
    assert (seen.state, seen.sent_at) == ("sent", clock.now)
    assert [i.state for i in assessments.list_invites(owner)] == ["sent"] and assessments.list_invites(owner, state="created") == []


def test_an_invite_past_its_expiry_is_closed_when_read_and_a_new_one_can_be_made(assessments, companies, sessions, clock, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    token = token_in(mail_rows(sessions)[0])
    clock.advance(days=7, seconds=1)
    seen = assessments.get_invite(owner, invite.invite_id)
    assert seen.state == "expired" and seen.closed_at == clock.now
    assert assessments.find_by_token(token).state == "expired", "the link shows a closed invite"
    assert entries(audit, "invite.expired")[0][3]["invite"] == invite.invite_id and len(entries(audit, "invite.expired")) == 1
    with pytest.raises(InviteClosed) as e:
        assessments.resend(owner, invite.invite_id)
    assert e.value.state == "expired"
    assert assessments.create_invite(owner, template.template_id, CAND).state == "created"


def test_an_expired_live_invite_does_not_block_a_new_one_even_if_nobody_read_it(assessments, companies, sessions, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    old = assessments.create_invite(owner, template.template_id, CAND)
    clock.advance(days=8)
    new = assessments.create_invite(owner, template.template_id, CAND)
    assert new.invite_id != old.invite_id and assessments.get_invite(owner, old.invite_id).state == "expired"


def test_cancel_before_the_mail_left_revoke_after_and_a_closed_invite_stays_closed(assessments, companies, sessions, clock, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    one = assessments.create_invite(owner, template.template_id, "one@example.org")
    two = assessments.create_invite(owner, template.template_id, "two@example.org")
    with pytest.raises(InviteClosed) as e:
        assessments.revoke(owner, one.invite_id)  # created: cancel, not revoke
    assert e.value.state == "created"
    cancelled = assessments.cancel(owner, one.invite_id)
    assert (cancelled.state, cancelled.closed_at) == ("cancelled", clock.now)
    deliver(sessions, mail_rows(sessions)[1].id, clock.now)
    with pytest.raises(InviteClosed) as e2:
        assessments.cancel(owner, two.invite_id)  # sent: revoke, not cancel
    assert e2.value.state == "sent"
    assert assessments.revoke(owner, two.invite_id).state == "revoked"
    for call in (lambda: assessments.cancel(owner, one.invite_id), lambda: assessments.revoke(owner, one.invite_id), lambda: assessments.revoke(owner, two.invite_id),
                 lambda: assessments.resend(owner, one.invite_id), lambda: assessments.resend(owner, two.invite_id)):
        with pytest.raises(InviteClosed):
            call()
    assert [e[0] for e in entries(audit) if e[0].startswith("invite.")] == ["invite.created", "invite.created", "invite.cancelled", "invite.sent", "invite.revoked"]


def test_resend_gives_a_new_token_kills_the_old_one_and_sends_a_new_mail(assessments, companies, sessions, clock, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    old = token_in(mail_rows(sessions)[0])
    deliver(sessions, mail_rows(sessions)[0].id, clock.now)
    assert assessments.get_invite(owner, invite.invite_id).state == "sent"
    clock.advance(days=3)
    again = assessments.resend(owner, invite.invite_id)
    new = token_in(mail_rows(sessions)[1])
    assert new != old and again.invite_id == invite.invite_id and again.state == "created" and again.sent_at is None
    assert again.expires_at == clock.now + timedelta(days=7), "the new link starts its own expiry"
    assert assessments.find_by_token(old) is None, "the old link is dead at once"
    assert assessments.find_by_token(new).invite_id == invite.invite_id
    assert len(mail_rows(sessions)) == 2 and KEYS.open(mail_rows(sessions)[1].to_address_sealed, account=invite.invite_id) == CAND
    assert entries(audit, "invite.resent")[0][3] == {"org": owner.org_id, "invite": invite.invite_id}


def test_resend_is_refused_once_the_candidate_consented(assessments, companies, sessions):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    assessments.advance(owner.org_id, invite.invite_id, "opened")
    assessments.advance(owner.org_id, invite.invite_id, "consented")
    with pytest.raises(InviteClosed) as e:
        assessments.resend(owner, invite.invite_id)
    assert e.value.state == "consented"
    assert assessments.revoke(owner, invite.invite_id).state == "revoked", "a consented invite can still be revoked"


def test_find_by_token_finds_only_a_real_live_token_of_the_company_it_names(assessments, companies, sessions):
    import uuid

    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    token = token_in(mail_rows(sessions)[0])
    assert assessments.find_by_token(token).invite_id == invite.invite_id
    prefix, secret = token.split(".")
    assert assessments.find_by_token(f"{prefix}.{'A' * 43}") is None, "wrong secret"
    assert assessments.find_by_token(f"{tokens.new_token(uuid.uuid4()).split('.')[0]}.{secret}") is None, "another company's prefix with this secret"
    for bad in ("", "x", token + "x", token[:-1]):
        assert assessments.find_by_token(bad) is None


def test_the_legal_moves_of_the_lifecycle_and_only_those(assessments, companies, sessions, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    states = ("created", "sent", "opened", "consented", "started", "expired", "cancelled", "declined", "revoked")

    def fresh(email, to):
        invite = assessments.create_invite(owner, template.template_id, email)
        path = {"created": [], "sent": ["sent"], "opened": ["sent", "opened"], "consented": ["sent", "opened", "consented"], "started": ["sent", "opened", "consented", "started"]}
        for step in path.get(to, []):
            assessments.advance(owner.org_id, invite.invite_id, step)
        return invite

    n = 0
    for source in ("created", "sent", "opened", "consented"):
        for target in states:
            n += 1
            invite = fresh(f"u{n}@example.org", source)
            if target in EDGES[source]:
                moved = assessments.advance(owner.org_id, invite.invite_id, target)
                assert moved.state == target
            else:
                with pytest.raises(InviteClosed) as e:
                    assessments.advance(owner.org_id, invite.invite_id, target)
                assert e.value.state == source
    done = fresh("done@example.org", "started")
    for target in states:
        with pytest.raises(InviteClosed):
            assessments.advance(owner.org_id, done.invite_id, target)


def test_every_move_is_stamped_and_the_implicit_open_counts_as_delivered(assessments, companies, sessions, clock, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    clock.advance(minutes=1)
    opened = assessments.advance(owner.org_id, invite.invite_id, "opened")  # created -> opened: the link was opened, so the mail was delivered
    assert (opened.state, opened.opened_at, opened.sent_at) == ("opened", clock.now, clock.now)
    clock.advance(minutes=1)
    consented = assessments.advance(owner.org_id, invite.invite_id, "consented")
    clock.advance(minutes=1)
    started = assessments.advance(owner.org_id, invite.invite_id, "started")
    assert consented.consented_at == T0 + timedelta(minutes=2) and started.started_at == T0 + timedelta(minutes=3) and started.closed_at is None
    assert [e[0] for e in entries(audit) if e[0].startswith("invite.")] == ["invite.created", "invite.opened", "invite.consented", "invite.started"]
    with pytest.raises(InviteNotFound):
        assessments.advance(owner.org_id, "i-AAAAAAAAAAAAAAAA", "opened")


def test_a_started_invite_never_expires(assessments, companies, sessions, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    for step in ("opened", "consented", "started"):
        assessments.advance(owner.org_id, invite.invite_id, step)
    clock.advance(days=60)
    assert assessments.get_invite(owner, invite.invite_id).state == "started"
    assert assessments.expire_due(owner.org_id) == 0


def test_expire_due_and_expire_all_close_what_is_past_expiry_in_every_company(assessments, companies, sessions, clock):
    ana = active_company(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    t = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, t.version, t.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    ta, td = assessments.create_template(ana, basic()), assessments.create_template(dee, basic(invite_expiry_days=2))
    keep = assessments.create_invite(ana, ta.template_id, "a@example.org")
    dies_a = assessments.create_invite(ana, ta.template_id, "b@example.org")
    dies_d = assessments.create_invite(dee, td.template_id, "a@example.org")
    clock.advance(days=3)
    assert assessments.expire_due(other_org) == 1, "Dee's invite has a two-day expiry"
    assert assessments.expire_all() == 0, "Ana's have seven days"
    assert {i.invite_id: i.state for i in assessments.list_invites(ana)} == {keep.invite_id: "created", dies_a.invite_id: "created"}
    clock.advance(days=5)
    assert assessments.expire_all() == 2
    assert {i.state for i in assessments.list_invites(ana)} == {"expired"} and assessments.list_invites(dee)[0].invite_id == dies_d.invite_id
    assert assessments.expire_all() == 0


# ---- what stays inside a company ------------------------------------------------------------------------------------------------------------

def test_one_company_cannot_see_or_change_anothers_invites(assessments, companies, sessions):
    ana = active_company(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    t = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, t.version, t.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    mine = assessments.create_invite(ana, assessments.create_template(ana, basic()).template_id, CAND)
    assert assessments.list_invites(dee) == []
    for call in (lambda: assessments.get_invite(dee, mine.invite_id), lambda: assessments.cancel(dee, mine.invite_id), lambda: assessments.revoke(dee, mine.invite_id),
                 lambda: assessments.resend(dee, mine.invite_id)):
        with pytest.raises(InviteNotFound):
            call()
    assert assessments.get_invite(ana, mine.invite_id).state == "created", "nothing changed"
    with ContextScopePort().acting_as(dee):
        with sessions() as s:
            assert s.scalars(select(Invite)).all() == [] and s.scalars(select(AssessmentTemplate)).all() == [] and s.scalars(select(TemplateChallenge)).all() == []
            assert s.get(Invite, mine.invite_id) is None


def test_the_invite_list_is_newest_first_and_can_be_filtered(assessments, companies, sessions, clock):
    owner = active_company(companies, sessions)
    one, two = assessments.create_template(owner, basic()), assessments.create_template(owner, basic(title="Two"))
    a = assessments.create_invite(owner, one.template_id, "a@example.org")
    clock.advance(minutes=1)
    b = assessments.create_invite(owner, two.template_id, "b@example.org")
    assert [i.invite_id for i in assessments.list_invites(owner)] == [b.invite_id, a.invite_id]
    assert [i.invite_id for i in assessments.list_invites(owner, template_id=one.template_id)] == [a.invite_id]
    assert [i.invite_id for i in assessments.list_invites(owner, limit=1)] == [b.invite_id]
    with pytest.raises(TemplateNotFound):
        assessments.list_invites(owner, template_id="nope")

def test_a_refused_change_still_leaves_the_invite_settled_and_audited_once(assessments, companies, sessions, clock, audit):
    """The lazy `sent` and `expired` steps run in a transaction of their own: a resend that is refused because the invite expired must not roll the expiry back,
    and asking again must not write the audit entry again."""
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    clock.advance(days=8)
    for _ in range(3):
        with pytest.raises(InviteClosed) as e:
            assessments.resend(owner, invite.invite_id)
        assert e.value.state == "expired"
    assert [x[0] for x in entries(audit) if x[0] == "invite.expired"] == ["invite.expired"], "once"
    with ContextScopePort().acting_as(owner):
        with sessions() as s:
            assert s.get(Invite, invite.invite_id).state == "expired", "the refusal did not undo the expiry"


def test_the_delivery_is_audited_once_when_it_is_first_seen(assessments, companies, sessions, clock, audit):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    deliver(sessions, mail_rows(sessions)[0].id, clock.now)
    for _ in range(3):
        assert assessments.get_invite(owner, invite.invite_id).state == "sent"
    assert [x[0] for x in entries(audit) if x[0] == "invite.sent"] == ["invite.sent"]