"""Story P-21 against a real Postgres 18 as the application role: migration 0011, the policy `own_invite` (a signed-in candidate reads the invite bound to them and nothing
else, with no company in scope, and cannot change it), the unique attempt id, the whole accept-consent-attempt flow through row-level security, and the races (eight
accepts of one link, two accounts binding one invite, eight re-invites of one invite, eight clicks on one consent). Skipped unless VULNMART_TEST_POSTGRES_DSN and
VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import datetime
import os
import re

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from vulnmart_attempts import AttemptEngine, FakeClock, InMemoryAttemptStore, InMemoryInstanceControl

import vulnmart.assessments.models  # noqa: F401
from support import ROOT
from test_assessments_postgres import BASIC, KEYS, ORIGIN, assessments, company, run, uid  # noqa: F401
from test_companies_postgres import (  # noqa: F401 - the fixtures of story P-18
    APP, OWNER, app_engine, clean, companies, database, owner, sessions, settings_query,
)
from test_kernel_postgres import with_db
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.roles import RoleService
from vulnmart.assessments.accept import InviteAcceptance, InviteConsentTargets
from vulnmart.assessments.service import AssessmentService, InviteClosed, InviteTaken
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.ports.engine_attempts import EngineAttemptPort
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.consent import ConsentService

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
SCOPE = ContextScopePort()
CAND = "candidate@example.org"


class Rig:
    def __init__(self, sessions, companies, owner_engine):
        self.sessions, self.owner_engine = sessions, owner_engine
        self.audit = FakeAuditPort()
        self.engine = AttemptEngine(InMemoryAttemptStore(), InMemoryInstanceControl(), FakeClock(datetime.datetime(2026, 10, 18, tzinfo=datetime.UTC)))
        self.attempts = EngineAttemptPort(self.engine)
        self.assessments = AssessmentService(sessions, companies, self.audit, SCOPE, FakeSettingsPort(), KEYS, public_origin=ORIGIN, attempts=self.attempts)
        self.roles = RoleService(sessions, self.audit)
        self.accept = InviteAcceptance(self.assessments, UserDirectory(sessions))
        self.targets = InviteConsentTargets(self.assessments, self.attempts, self.roles)
        self.consent = ConsentService(sessions, self.targets, self.audit, FakeSettingsPort(), KEYS)
        self.owner = company(companies, owner_engine)
        self.template = self.assessments.create_template(self.owner, BASIC)

    def candidate(self, email=CAND, verified=True, user_id=None):
        user_id = user_id or "u-" + re.sub(r"[^A-Z2-7]", "A", email.upper())[:16].ljust(16, "A")
        with self.owner_engine.begin() as c:
            c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at) "
                           "VALUES (:i, 'participant', :e, :e, 'x', 'Cand', 'active', CASE WHEN :v THEN now() END)"), {"i": user_id, "e": email, "v": verified})
        return user_id

    def invite(self, email=CAND):
        view = self.assessments.create_invite(self.owner, self.template.template_id, email)
        with self.owner_engine.connect() as c:
            params = c.execute(text("SELECT params FROM email_outbox WHERE template = 'candidate.invite' AND to_user_id = :i"), {"i": view.invite_id}).scalar_one()
        return view, re.search(r"token=([^&\"]+)", params["link"]).group(1)

    def decide(self, user, attempt_id, decision="granted"):
        with SCOPE.acting_as(Scope(user_id=user, roles=frozenset({Role.LEARNER}))):
            n = self.consent.notice(user, attempt_id)[1]
            return self.consent.record(user_id=user, attempt_id=attempt_id, notice_version=n.version, notice_sha256=n.sha256, decision=decision, ip="203.0.113.7",
                                       user_agent="Test")


@pytest.fixture
def rig(sessions, companies, owner):
    return Rig(sessions, companies, owner)


def values(owner, sql, **params):
    with owner.connect() as c:
        return c.execute(text(sql), params).all()


# ---- the policy and the columns ---------------------------------------------------------------------------------------------------------

def test_invites_have_the_two_policies_the_new_columns_and_a_unique_attempt_id(owner):
    with owner.connect() as c:
        policies = {r[0] for r in c.execute(text("SELECT policyname FROM pg_policies WHERE tablename = 'invites'"))}
        columns = {r[0] for r in c.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'invites'"))}
        unique = c.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_invites_attempt_id'")).scalar_one()
    assert policies == {"org_scope", "own_invite"} and {"user_id", "attempt_id", "generation", "supersedes_attempt_id"} <= columns
    assert "UNIQUE" in unique and "attempt_id IS NOT NULL" in unique


def test_a_candidate_reads_only_the_invite_bound_to_them_with_no_company_and_cannot_change_it(rig, app_engine, owner):
    first, token = rig.invite()
    other, other_token = rig.invite("other@example.org")
    me, them = rig.candidate(), rig.candidate("other@example.org")
    mine = rig.accept.accept(me, token).attempt_id
    theirs = rig.accept.accept(them, other_token).attempt_id
    assert [r[0] for r in settings_query(app_engine, "SELECT attempt_id FROM invites", vulnmart__user_id=me)] == [mine]
    assert [r[0] for r in settings_query(app_engine, "SELECT attempt_id FROM invites", vulnmart__user_id=them)] == [theirs]
    assert settings_query(app_engine, "SELECT 1 FROM invites", vulnmart__user_id="u-NOBODYNOBODYNOBO") == []
    assert settings_query(app_engine, "SELECT 1 FROM invites") == [], "no one in scope reads nothing"
    assert settings_query(app_engine, f"UPDATE invites SET state = 'revoked' WHERE id = '{first.invite_id}' RETURNING 1", vulnmart__user_id=me) == []
    assert settings_query(app_engine, f"UPDATE invites SET user_id = '{me}' WHERE id = '{other.invite_id}' RETURNING 1", vulnmart__user_id=me) == []
    assert values(owner, "SELECT user_id FROM invites WHERE id = :i", i=other.invite_id) == [(them,)]


def test_an_attempt_id_belongs_to_one_invite(rig, owner):
    first, token = rig.invite()
    other, other_token = rig.invite("other@example.org")
    rig.accept.accept(rig.candidate(), token)
    rig.accept.accept(rig.candidate("other@example.org"), other_token)
    with pytest.raises(DBAPIError, match="uq_invites_attempt_id"):
        with owner.begin() as c:
            c.execute(text("UPDATE invites SET attempt_id = (SELECT attempt_id FROM invites WHERE id = :a) WHERE id = :b"), {"a": first.invite_id, "b": other.invite_id})


# ---- the whole flow through row-level security ------------------------------------------------------------------------------------------

def test_accept_consent_attempt_and_role_through_row_level_security(rig, owner):
    invite, token = rig.invite()
    user = rig.candidate()
    attempt_id = rig.accept.accept(user, token).attempt_id
    with SCOPE.acting_as(Scope(user_id=user, roles=frozenset({Role.LEARNER}))):
        target, notice = rig.consent.notice(user, attempt_id)
    assert target.state == "consent" and target.company_name == "Acme" and target.user_id == user
    record = rig.decide(user, attempt_id)
    assert values(owner, "SELECT state, user_id, attempt_id FROM invites WHERE id = :i", i=invite.invite_id) == [("consented", user, attempt_id)]
    assert values(owner, "SELECT attempt_id, action, notice_version FROM consent_records WHERE id = :i", i=record.consent_id)[0][:2] == (attempt_id, "granted")
    assert rig.attempts.get(attempt_id).state.value == "ready"
    assert values(owner, "SELECT role FROM user_roles WHERE user_id = :u", u=user) == [("candidate",)]


def test_a_decline_through_row_level_security_closes_the_invite(rig, owner):
    invite, token = rig.invite()
    user = rig.candidate()
    rig.decide(user, rig.accept.accept(user, token).attempt_id, "declined")
    assert values(owner, "SELECT state FROM invites WHERE id = :i", i=invite.invite_id) == [("declined",)]
    assert values(owner, "SELECT count(*) FROM user_roles WHERE user_id = :u", u=user) == [(0,)]


def test_a_reinvite_through_row_level_security(rig, owner):
    old, token = rig.invite()
    user = rig.candidate()
    attempt_id = rig.accept.accept(user, token).attempt_id
    rig.decide(user, attempt_id)
    new = rig.assessments.reinvite(rig.owner, old.invite_id)
    assert values(owner, "SELECT state, superseded_by, generation FROM invites WHERE id = :i", i=old.invite_id) == [("revoked", new.invite_id, 1)]
    assert values(owner, "SELECT generation, supersedes_attempt_id FROM invites WHERE id = :i", i=new.invite_id) == [(2, attempt_id)]
    assert rig.attempts.get(attempt_id).state.value == "cancelled"


def test_bulk_invites_and_the_purge_through_row_level_security(rig, owner):
    result = rig.assessments.create_invites(rig.owner, rig.template.template_id, [f"p{i}@example.org" for i in range(5)])
    assert len(result.created) == 5
    for view in result.created[:2]:
        rig.assessments.cancel(rig.owner, view.invite_id)
    assert rig.assessments.purge_closed_tokens(datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=1)) == 2
    assert values(owner, "SELECT count(*) FROM invites WHERE token_hash IS NULL") == [(2,)]


# ---- races -------------------------------------------------------------------------------------------------------------------------------

def test_eight_accepts_of_one_link_bind_it_once_and_give_everyone_the_same_attempt_id(rig, owner):
    invite, token = rig.invite()
    user = rig.candidate()
    out = run(8, lambda i: rig.accept.accept(user, token).attempt_id)
    assert [k for k, _ in out] == ["ok"] * 8, [(k, v) for k, v in out if k != "ok"]
    assert len({v for _, v in out}) == 1
    assert [r.action for r in rig.audit.records].count("invite.bound") == 1, "one binding, one audit entry, however many clicks"


def test_two_accounts_binding_one_invite_leave_exactly_one_owner(rig, owner):
    invite, token = rig.invite()
    a, b = rig.candidate(), rig.candidate("other@example.org")
    rig.accept.open_link(token)
    out = run(2, lambda i: rig.assessments.bind_candidate(rig.owner.org_id, invite.invite_id, (a, b)[i]))
    assert sorted(k for k, _ in out) == ["InviteTaken", "ok"], [k for k, _ in out]
    winner = values(owner, "SELECT user_id FROM invites WHERE id = :i", i=invite.invite_id)[0][0]
    assert winner in (a, b)


def test_eight_reinvites_of_one_invite_make_one_new_invite(rig, owner):
    old, token = rig.invite()
    user = rig.candidate()
    rig.decide(user, rig.accept.accept(user, token).attempt_id)
    out = run(8, lambda i: rig.assessments.reinvite(rig.owner, old.invite_id))
    kinds = [k for k, _ in out]
    assert kinds.count("ok") == 1 and kinds.count("InviteClosed") == 7, kinds
    assert values(owner, "SELECT count(*) FROM invites WHERE supersedes_attempt_id IS NOT NULL") == [(1,)]
    assert values(owner, "SELECT count(*) FROM email_outbox WHERE template = 'candidate.invite'") == [(2,)]


def test_eight_clicks_on_one_consent_make_one_record_one_attempt_and_one_role(rig, owner):
    invite, token = rig.invite()
    user = rig.candidate()
    attempt_id = rig.accept.accept(user, token).attempt_id
    with SCOPE.acting_as(Scope(user_id=user, roles=frozenset({Role.LEARNER}))):
        n = rig.consent.notice(user, attempt_id)[1]

    def click(i):
        with SCOPE.acting_as(Scope(user_id=user, roles=frozenset({Role.LEARNER}))):
            return rig.consent.record(user_id=user, attempt_id=attempt_id, notice_version=n.version, notice_sha256=n.sha256, decision="granted", ip=None, user_agent=None)

    out = run(8, click)
    assert [k for k, _ in out] == ["ok"] * 8, [(k, v) for k, v in out if k != "ok"]
    assert values(owner, "SELECT count(*) FROM consent_records WHERE attempt_id = :a", a=attempt_id) == [(1,)]
    assert values(owner, "SELECT count(*) FROM user_roles WHERE user_id = :u AND role = 'candidate'", u=user) == [(1,)]
    assert values(owner, "SELECT state FROM invites WHERE id = :i", i=invite.invite_id) == [("consented",)]
    assert rig.attempts.get(attempt_id).state.value == "ready"


def test_a_revoke_and_an_accept_at_once_never_leave_a_bound_attempt_on_a_revoked_invite(rig, owner):
    invite, token = rig.invite()
    user = rig.candidate()
    rig.accept.open_link(token)
    out = run(2, lambda i: rig.assessments.revoke(rig.owner, invite.invite_id) if i == 0 else rig.accept.accept(user, token))
    state = values(owner, "SELECT state FROM invites WHERE id = :i", i=invite.invite_id)[0][0]
    kinds = sorted(k for k, _ in out)
    assert (kinds, state) in ((["InviteClosed", "ok"], "revoked"), (["ok", "ok"], "revoked"))


# ---- the migration -----------------------------------------------------------------------------------------------------------------------

def test_migration_0011_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0010")
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name = 'invites' AND column_name IN "
                              "('user_id', 'attempt_id', 'generation', 'supersedes_attempt_id')")).scalar_one() == 0
        assert c.execute(text("SELECT count(*) FROM pg_policies WHERE tablename = 'invites'")).scalar_one() == 1
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM pg_policies WHERE tablename = 'invites'")).scalar_one() == 2
        assert c.execute(text("SELECT to_regclass('uq_invites_attempt_id')")).scalar_one() == "uq_invites_attempt_id"
