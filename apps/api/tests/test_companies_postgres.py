"""Story P-18 against a real Postgres 18 as the application role: migration 0008, the row-level security that lets an admin READ the company directory and a
person read their OWN membership (and nothing else), cross-company isolation, and the races of signup and of an admin's decision.

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py).
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import DBAPIError

import vulnmart.accounts.models  # noqa: F401
import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.orgs.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.models import User
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService
from vulnmart.kernel.db import make_sessions
from vulnmart.kernel.scope import ContextScopePort, scope_or_none
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.notifications.models import EmailOutbox
from vulnmart.orgs.models import Organization
from vulnmart.orgs.service import CompanyService, InvalidTransition
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
GOOD = "correct horse battery staple"
ORIGIN = "https://vulnmart.example"
ADMIN = "u-ADMINADMINADMIN2"
ADMIN_SCOPE = Scope(user_id=ADMIN, roles=frozenset({Role.ADMIN}))


@pytest.fixture(scope="module")
def database():
    name = f"vm_p18_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, name)
    try:
        command.upgrade(Config(str(ROOT / "apps" / "api" / "alembic.ini")), "head")
        app = create_engine(sqlalchemy_url(with_db(APP, name)), pool_size=12)
        owner = create_engine(sqlalchemy_url(with_db(OWNER, name)))
        yield app, owner, name
        app.dispose()
        owner.dispose()
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        os.environ.pop("VULNMART_MIGRATE_DSN", None)


@pytest.fixture
def app_engine(database):
    return database[0]


@pytest.fixture
def owner(database):
    return database[1]


@pytest.fixture(autouse=True)
def clean(owner):
    with owner.begin() as c:
        c.execute(text("DELETE FROM email_outbox"))
        c.execute(text("DELETE FROM organizations"))  # members go with their company (ON DELETE CASCADE)
        c.execute(text("DELETE FROM users"))
    yield


@pytest.fixture
def sessions(app_engine):
    return make_sessions(app_engine, scope_or_none)


@pytest.fixture
def companies(sessions):
    audit = FakeAuditPort()
    accounts = AccountService(sessions, FakeSettingsPort(), public_origin=ORIGIN, policy=PasswordPolicy())
    return CompanyService(sessions, accounts, UserDirectory(sessions), RoleService(sessions, audit), audit, ContextScopePort(), public_origin=ORIGIN)


def add_admin(owner):
    with owner.begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at) "
                       "VALUES (:i, 'admin', 'admin@example.org', 'admin@example.org', 'x', 'Admin', 'active', now())"), {"i": ADMIN})


def signup(companies, email, company="Acme", name="Ana"):
    companies.signup_recruiter(email=email, password=GOOD, display_name=name, company_name=company)


def seed_two_companies(owner):
    a, b = uuid.uuid4(), uuid.uuid4()
    with owner.begin() as c:
        for i, (oid, uid, status) in enumerate(((a, "u-AAAAAAAAAAAAAAAA", "pending"), (b, "u-BBBBBBBBBBBBBBBB", "active"))):
            c.execute(text("INSERT INTO organizations (id, name, email_domain, status, owner_user_id) VALUES (:i, :n, 'd.example', :s, :u)"),
                      {"i": oid, "n": f"Company {i}", "s": status, "u": uid})
            c.execute(text("INSERT INTO org_members (org_id, user_id, role, status) VALUES (:i, :u, 'owner', 'active')"), {"i": oid, "u": uid})
    return a, b


def settings_query(engine, sql, **settings):
    """Run one query as the application role in a transaction whose per-transaction settings are `settings` (what the scoped session does)."""
    with engine.begin() as c:
        for name, value in settings.items():
            c.execute(text("SELECT set_config(:n, :v, true)"), {"n": name.replace("__", "."), "v": value})
        return c.execute(text(sql)).all()


# ---- row-level security ---------------------------------------------------------------------------------------------------------------

def test_the_policies_of_migration_0008_exist_and_are_read_only(owner):
    with owner.connect() as c:
        rows = {(r[0], r[1], r[2]) for r in c.execute(text("SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2"))}
    assert ("organizations", "admin_read", "SELECT") in rows and ("org_members", "own_membership", "SELECT") in rows
    assert ("organizations", "org_scope", "ALL") in rows and ("org_members", "org_scope", "ALL") in rows


def test_without_a_setting_no_company_row_is_visible(app_engine, owner):
    seed_two_companies(owner)
    assert settings_query(app_engine, "SELECT count(*) FROM organizations")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM org_members")[0][0] == 0


def test_the_admin_setting_reads_every_company_but_no_member(app_engine, owner):
    seed_two_companies(owner)
    assert settings_query(app_engine, "SELECT count(*) FROM organizations", vulnmart__admin="on")[0][0] == 2
    assert settings_query(app_engine, "SELECT count(*) FROM org_members", vulnmart__admin="on")[0][0] == 0, "an admin does not read the members of companies"
    assert settings_query(app_engine, "SELECT count(*) FROM organizations", vulnmart__admin="off")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM organizations", vulnmart__admin="ON ")[0][0] == 0, "only the exact value `on`"


@pytest.mark.parametrize("sql", [
    "UPDATE organizations SET status = 'active'", "DELETE FROM organizations",
    "INSERT INTO organizations (id, name, email_domain, status, owner_user_id) VALUES (gen_random_uuid(), 'x', 'd.example', 'pending', 'u-X')",
])
def test_the_admin_setting_grants_a_read_only(app_engine, owner, sql):
    seed_two_companies(owner)
    try:
        changed = settings_query(app_engine, sql + " RETURNING 1", vulnmart__admin="on")
    except DBAPIError:
        changed = []  # a row-level security violation on insert is an error: also a refusal
    assert changed == []
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM organizations WHERE status IN ('pending', 'active')")).scalar_one() == 2


def test_a_person_reads_their_own_membership_and_no_one_elses(app_engine, owner):
    a, b = seed_two_companies(owner)
    rows = settings_query(app_engine, "SELECT user_id, org_id FROM org_members", vulnmart__user_id="u-AAAAAAAAAAAAAAAA")
    assert [(r[0], str(r[1])) for r in rows] == [("u-AAAAAAAAAAAAAAAA", str(a))]
    assert settings_query(app_engine, "SELECT count(*) FROM org_members", vulnmart__user_id="u-NOBODYNOBODYNOBO")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM org_members", vulnmart__user_id="")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM organizations", vulnmart__user_id="u-AAAAAAAAAAAAAAAA")[0][0] == 0, "knowing who I am opens no company row"
    with pytest.raises(DBAPIError):
        settings_query(app_engine, "INSERT INTO org_members (org_id, user_id, role, status) VALUES (gen_random_uuid(), 'u-AAAAAAAAAAAAAAAA', 'owner', 'active')",
                       vulnmart__user_id="u-AAAAAAAAAAAAAAAA")


def test_a_company_in_scope_sees_only_itself(app_engine, owner):
    a, b = seed_two_companies(owner)
    assert [str(r[0]) for r in settings_query(app_engine, "SELECT id FROM organizations", vulnmart__org_id=str(a))] == [str(a)]
    assert [str(r[0]) for r in settings_query(app_engine, "SELECT org_id FROM org_members", vulnmart__org_id=str(b))] == [str(b)]
    assert settings_query(app_engine, "UPDATE organizations SET name = 'x' WHERE id = :b RETURNING 1".replace(":b", f"'{b}'"), vulnmart__org_id=str(a)) == []


# ---- the service as the application role ----------------------------------------------------------------------------------------------

def test_signup_approval_and_the_queue_work_through_row_level_security(companies, owner):
    add_admin(owner)
    signup(companies, "ana@acme.example", "Acme", "Ana A")
    signup(companies, "bo@gmail.com", "Bo Consulting", "Bo B")
    with owner.begin() as c:
        c.execute(text("UPDATE users SET email_verified_at = now()"))
    queue = companies.pending(ADMIN_SCOPE)
    assert [(q.name, q.owner_name, q.owner_email_domain) for q in queue] == [("Acme", "Ana A", "acme.example"), ("Bo Consulting", "Bo B", "gmail.com")]
    companies.approve(ADMIN_SCOPE, queue[0].org_id)
    companies.reject(ADMIN_SCOPE, queue[1].org_id, "We cannot verify this company.")
    assert companies.pending(ADMIN_SCOPE) == []
    with owner.connect() as c:
        states = dict(c.execute(text("SELECT name, status FROM organizations")).all())
        mails = c.execute(text("SELECT template, params FROM email_outbox WHERE template = 'org.approval_outcome' ORDER BY id")).all()
    assert states == {"Acme": "active", "Bo Consulting": "rejected"} and len(mails) == 2
    assert [m[1]["outcome"] for m in mails] == ["approved", "rejected"]
    ana = companies.standing(_uid(owner, "ana@acme.example"))
    assert ana.state == "active" and companies.active_company_of(ana_id := _uid(owner, "ana@acme.example")) == ana.org_id and ana_id
    assert companies.standing(_uid(owner, "bo@gmail.com")).reason == "We cannot verify this company."


def _uid(owner, email):
    with owner.connect() as c:
        return c.execute(text("SELECT id FROM users WHERE email_ci = :e"), {"e": email}).scalar_one()


def test_a_recruiter_cannot_read_another_company_through_the_service_scope(sessions, companies, owner):
    signup(companies, "ana@acme.example", "Acme")
    signup(companies, "bo@other.example", "Other")
    ana, bo = _uid(owner, "ana@acme.example"), _uid(owner, "bo@other.example")
    bo_org = companies.standing(bo).org_id
    with ContextScopePort().acting_as(Scope(user_id=ana, org_id=companies.standing(ana).org_id, roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            assert [o.name for o in s.scalars(select(Organization)).all()] == ["Acme"]
            assert s.get(Organization, uuid.UUID(bo_org)) is None


def test_eight_simultaneous_signups_for_one_address_make_one_account_and_one_company(companies, owner):
    barrier, errors = threading.Barrier(8), []

    def go():
        barrier.wait()
        try:
            signup(companies, "race@acme.example", "Race Ltd")
        except Exception as exc:  # noqa: BLE001 - counted below
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM users")).scalar_one() == 1
        assert c.execute(text("SELECT count(*) FROM organizations")).scalar_one() == 1
        assert c.execute(text("SELECT count(*) FROM org_members")).scalar_one() == 1
        templates = sorted(r[0] for r in c.execute(text("SELECT template FROM email_outbox")))
    assert templates.count("account.verify") == 1 and templates.count("account.already_registered") == 7


def test_eight_admins_deciding_one_company_at_once_leave_one_decision_and_one_mail(companies, owner):
    add_admin(owner)
    signup(companies, "ana@acme.example", "Acme")
    org_id = companies.standing(_uid(owner, "ana@acme.example")).org_id
    barrier, results = threading.Barrier(8), []

    def decide(i: int):
        barrier.wait()
        try:
            if i % 2:
                companies.approve(ADMIN_SCOPE, org_id)
                results.append("approved")
            else:
                companies.reject(ADMIN_SCOPE, org_id, "no")
                results.append("rejected")
        except InvalidTransition:
            results.append("late")

    threads = [threading.Thread(target=decide, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(set(results) - {"late"}) in (["approved"], ["rejected"]) and results.count("late") == 7
    with owner.connect() as c:
        status = c.execute(text("SELECT status FROM organizations")).scalar_one()
        mails = c.execute(select(func.count()).select_from(EmailOutbox).where(EmailOutbox.template == "org.approval_outcome")).scalar_one()
    assert status in ("active", "rejected") and mails == 1


def test_migration_0008_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0007")
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM pg_policies WHERE policyname IN ('admin_read', 'own_membership')")).scalar_one() == 0
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM pg_policies WHERE policyname IN ('admin_read', 'own_membership')")).scalar_one() == 2
