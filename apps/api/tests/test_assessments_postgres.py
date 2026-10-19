"""Story P-20 against a real Postgres 18 as the application role: migration 0010, the row-level security of the three assessment tables, the privileges, the unique
live invite and the unique token hash, the races (two creators of one invite, creators at the cap, a resend against a revoke, two moves of one invite) and the
cascade when a company goes. Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import os
import threading
import uuid

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

import vulnmart.assessments.models  # noqa: F401
from support import ROOT
from test_companies_postgres import (  # noqa: F401 - the fixtures of story P-18
    ADMIN_SCOPE, APP, OWNER, add_admin, app_engine, clean, companies, database, owner, sessions, settings_query, signup,
)
from test_kernel_postgres import with_db
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.assessments.models import Invite
from vulnmart.assessments.service import AssessmentService, InviteCapReached, InviteClosed, InviteExists
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.orgs.service import CompanyService
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
ORIGIN = "https://vulnmart.example"
BASIC = {"title": "T", "challenge_keys": ["C01", "C02"]}


@pytest.fixture
def assessments(sessions, companies):
    return AssessmentService(sessions, companies, FakeAuditPort(), ContextScopePort(), FakeSettingsPort(), KEYS, public_origin=ORIGIN)


def uid(owner, email):
    with owner.connect() as c:
        return c.execute(text("SELECT id FROM users WHERE email_ci = :e"), {"e": email}).scalar_one()


def company(companies, owner, email="ana@acme.example", name="Acme"):
    """An approved company whose owner accepted the terms; returns the owner's scope."""
    with owner.begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at) VALUES (:i, 'admin', 'admin@example.org', "
                       "'admin@example.org', 'x', 'Admin', 'active', now()) ON CONFLICT DO NOTHING"), {"i": "u-ADMINADMINADMIN2"})
    signup(companies, email, name, "Ana")
    with owner.begin() as c:
        c.execute(text("UPDATE users SET email_verified_at = now() WHERE email_ci = :e"), {"e": email})
    user = uid(owner, email)
    org = companies.standing(user).org_id
    companies.approve(ADMIN_SCOPE, org)
    t = companies.terms_for(user)
    companies.accept_terms(user, t.version, t.sha256)
    return Scope(user_id=user, org_id=org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))


# ---- row-level security and privileges --------------------------------------------------------------------------------------------------

def test_the_assessment_tables_are_scoped_forced_and_the_outbox_has_its_sealed_column(owner):
    with owner.connect() as c:
        flags = {r[0]: (r[1], r[2]) for r in c.execute(text("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN "
                                                              "('assessment_templates', 'template_challenges', 'invites')"))}
        policies = {(r[0], r[1]) for r in c.execute(text("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'"))}
        column = c.execute(text("SELECT data_type FROM information_schema.columns WHERE table_name = 'email_outbox' AND column_name = 'to_address_sealed'")).scalar_one()
    assert flags == {t: (True, True) for t in ("assessment_templates", "template_challenges", "invites")}
    assert all((t, "org_scope") in policies for t in flags) and column == "text"


def test_one_company_reads_only_its_own_assessment_rows(app_engine, owner, companies, assessments):
    ana = company(companies, owner)
    bo = company(companies, owner, "bo@other.example", "Other")
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "c@example.org")
    for table in ("assessment_templates", "template_challenges", "invites"):
        assert settings_query(app_engine, f"SELECT count(*) FROM {table}")[0][0] == 0
        assert settings_query(app_engine, f"SELECT count(*) FROM {table}", vulnmart__org_id=bo.org_id)[0][0] == 0
        assert settings_query(app_engine, f"SELECT count(*) FROM {table}", vulnmart__org_id=ana.org_id)[0][0] >= 1
        assert settings_query(app_engine, f"SELECT count(*) FROM {table}", vulnmart__admin="on")[0][0] == 0, "an admin does not read assessments or invites"
        assert settings_query(app_engine, f"SELECT count(*) FROM {table}", vulnmart__user_id=ana.user_id)[0][0] == 0
    assert settings_query(app_engine, "UPDATE invites SET state = 'revoked' WHERE id = '" + invite.invite_id + "' RETURNING 1", vulnmart__org_id=bo.org_id) == []


@pytest.mark.parametrize("statement", ["TRUNCATE invites", "TRUNCATE assessment_templates", "TRUNCATE template_challenges",
                                       "UPDATE template_challenges SET challenge_key = 'C03'"])
def test_the_application_role_cannot_do_what_it_must_not_to_the_assessment_tables(app_engine, statement):
    with pytest.raises(DBAPIError, match="permission denied"):
        with app_engine.begin() as c:
            c.execute(text(statement))


def test_the_application_role_may_delete_an_invite_only_of_the_company_in_scope(app_engine, owner, companies, assessments):
    """Since migration 0014 (story P-24) the retention job may delete invites; row-level security still decides whose."""
    ana = company(companies, owner)
    bo = company(companies, owner, "bo@other.example", "Other")
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "c@example.org")
    assert settings_query(app_engine, "DELETE FROM invites RETURNING 1") == [], "no company in scope: nothing is visible, nothing is deleted"
    assert settings_query(app_engine, "DELETE FROM invites RETURNING 1", vulnmart__org_id=bo.org_id) == [], "another company's scope: the same"
    assert settings_query(app_engine, "DELETE FROM invites RETURNING id", vulnmart__org_id=ana.org_id) == [(invite.invite_id,)]


def test_a_state_other_than_the_nine_is_refused_by_the_database(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "c@example.org")
    with pytest.raises(DBAPIError):
        with owner.begin() as c:
            c.execute(text("UPDATE invites SET state = 'sent-ish' WHERE id = :i"), {"i": invite.invite_id})


def test_the_database_keeps_the_template_ranges(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    for column, bad in (("time_limit_min", 29), ("time_limit_min", 481), ("hint_cost_pct", 101), ("reset_limit", 11), ("invite_expiry_days", 0), ("retention_days", 366)):
        with pytest.raises(DBAPIError):
            with owner.begin() as c:
                c.execute(text(f"UPDATE assessment_templates SET {column} = :v WHERE id = :i"), {"v": bad, "i": t.template_id})


def test_deleting_a_company_removes_its_templates_and_invites(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    assessments.create_invite(ana, t.template_id, "c@example.org")
    with owner.begin() as c:
        c.execute(text("DELETE FROM organizations"))
    with owner.connect() as c:
        assert [c.execute(text(f"SELECT count(*) FROM {t}")).scalar_one() for t in ("assessment_templates", "template_challenges", "invites")] == [0, 0, 0]


# ---- through row-level security, as the application role ---------------------------------------------------------------------------------

def test_the_whole_lifecycle_works_through_row_level_security(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "Candidate@Example.org")
    with owner.connect() as c:
        row = c.execute(text("SELECT token_hash, email_ci, state FROM invites WHERE id = :i"), {"i": invite.invite_id}).one()
        mail = c.execute(text("SELECT to_user_id, to_address_sealed, params FROM email_outbox WHERE template = 'candidate.invite'")).one()
    assert re.fullmatch(r"[0-9a-f]{64}", row[0]) and (row[1], row[2]) == ("candidate@example.org", "created")
    assert mail[0] == invite.invite_id and "@" not in mail[1] and KEYS.open(mail[1], account=invite.invite_id) == "candidate@example.org"
    token = re.search(r"token=([^&\"]+)", mail[2]["link"]).group(1)
    assert assessments.find_by_token(token).invite_id == invite.invite_id
    moved = assessments.advance(ana.org_id, invite.invite_id, "opened")
    assert moved.state == "opened" and assessments.revoke(ana, invite.invite_id).state == "revoked"
    again = assessments.create_invite(ana, t.template_id, "candidate@example.org")
    assert again.invite_id != invite.invite_id


import re  # noqa: E402 - used by the test above


# ---- races ---------------------------------------------------------------------------------------------------------------------------------

def run(n, work):
    barrier, out = threading.Barrier(n), []

    def go(i):
        barrier.wait()
        try:
            out.append(("ok", work(i)))
        except Exception as exc:  # noqa: BLE001 - counted by the test
            out.append((type(exc).__name__, exc))

    threads = [threading.Thread(target=go, args=(i,)) for i in range(n)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return out


def test_eight_creators_of_one_invite_make_one_invite_and_one_mail(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    out = run(8, lambda i: assessments.create_invite(ana, t.template_id, "same@example.org"))
    assert [k for k, _ in out].count("ok") == 1 and [k for k, _ in out].count("InviteExists") == 7, [k for k, _ in out]
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM invites")).scalar_one() == 1
        assert c.execute(text("SELECT count(*) FROM email_outbox WHERE template = 'candidate.invite'")).scalar_one() == 1


def test_creators_at_the_cap_never_pass_it(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    companies.set_invite_cap(ADMIN_SCOPE, ana.org_id, 3)
    out = run(10, lambda i: assessments.create_invite(ana, t.template_id, f"c{i}@example.org"))
    kinds = [k for k, _ in out]
    assert kinds.count("ok") == 3 and kinds.count("InviteCapReached") == 7, kinds
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM invites")).scalar_one() == 3
        assert c.execute(text("SELECT count(*) FROM email_outbox WHERE template = 'candidate.invite'")).scalar_one() == 3


def test_a_resend_and_a_revoke_at_once_leave_a_consistent_invite(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "c@example.org")
    with owner.begin() as c:
        c.execute(text("UPDATE email_outbox SET state = 'sent', sent_at = now(), to_address_sealed = NULL WHERE template = 'candidate.invite'"))
    out = run(2, lambda i: assessments.resend(ana, invite.invite_id) if i == 0 else assessments.revoke(ana, invite.invite_id))
    with owner.connect() as c:
        state, mails = c.execute(text("SELECT state, (SELECT count(*) FROM email_outbox WHERE template = 'candidate.invite') FROM invites WHERE id = :i"),
                                 {"i": invite.invite_id}).one()
    kinds = sorted(k for k, _ in out)
    # exactly one of the two wins: a revoke that came first closes the invite (and the resend is refused, no new mail); a resend that came first makes a fresh
    # `created` invite, which cannot be revoked until its new mail has left. Never both, and never a revoked invite brought back.
    assert kinds == ["InviteClosed", "ok"], kinds
    assert (state, mails) in {("revoked", 1), ("created", 2)}, (state, mails)


def test_eight_moves_of_one_invite_to_opened_leave_one_move(owner, companies, assessments):
    ana = company(companies, owner)
    t = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, t.template_id, "c@example.org")
    out = run(8, lambda i: assessments.advance(ana.org_id, invite.invite_id, "opened"))
    kinds = [k for k, _ in out]
    assert kinds.count("ok") == 1 and kinds.count("InviteClosed") == 7, kinds


def test_migration_0010_goes_down_and_up_again(database, owner):
    """Down to 0009 passes through 0012, 0011 and 0010; up again to the head."""
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0009")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('invites')")).scalar_one() is None
        assert c.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name = 'email_outbox' AND column_name = 'to_address_sealed'")).scalar_one() == 0
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('invites')")).scalar_one() == "invites"
        assert c.execute(text("SELECT count(*) FROM pg_policies WHERE tablename IN ('assessment_templates', 'template_challenges', 'invites')")).scalar_one() == 4  # org_scope on each, own_invite on invites
