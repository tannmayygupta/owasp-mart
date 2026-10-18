"""Story P-13: account types and roles (FR-ACC-05, FR-ACC-06), admin creation (FR-ACC-11) and the seed command, on SQLite."""
from __future__ import annotations

import io
import logging
import re
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts import security, seed_admin
from vulnmart.accounts.admins import EmailInUse, AdminService
from vulnmart.accounts.models import EmailToken, User, UserRole
from vulnmart.accounts.roles import NotAnAdmin, RoleNotAllowed, RoleService, UnknownUser
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.accounts.sessions import InvalidCredentials, SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.settings import Settings
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
PASSWORD = "correct horse battery staple"
ADMIN_PASSWORD = "a long admin password 123"
ORIGIN = "https://vulnmart.example"
_HASH = security.hash_password(PASSWORD)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def audit():
    return FakeAuditPort()


@pytest.fixture
def session_service(sessions):
    return SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=lambda: T0)


@pytest.fixture
def roles(sessions, audit, session_service):
    return RoleService(sessions, audit, session_service)


@pytest.fixture
def admins(sessions, audit):
    return AdminService(sessions, FakeSettingsPort(), audit, public_origin=ORIGIN, now=lambda: T0)


def add_user(sessions, uid, email, *, account_type="participant", status="active", roles=("learner",)):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash=_HASH, display_name="Test",
                   status=status, email_verified_at=T0))
        s.flush()
        if account_type == "participant":
            for role in roles:
                s.add(UserRole(user_id=uid, role=role, account_type="participant"))
    return uid


def held(sessions, uid):
    with sessions() as s:
        return sorted(s.scalars(select(UserRole.role).where(UserRole.user_id == uid)))


def admin_scope(uid="u-ADMINADMINADMIN2"):
    return Scope(user_id=uid, roles=frozenset({Role.ADMIN}))


LEARNER, RECRUITER, ADMIN = "u-AAAAAAAAAAAAAAAA", "u-RRRRRRRRRRRRRRRR", "u-ADMINADMINADMIN2"


# ---- the candidate role (FR-ACC-06) ------------------------------------------------------------------------------------

def test_accepting_an_invite_adds_the_candidate_role_beside_the_learner_role(sessions, roles, audit):
    add_user(sessions, LEARNER, "ada@example.com")
    assert roles.grant_candidate_role(LEARNER) is True
    assert held(sessions, LEARNER) == ["candidate", "learner"] and roles.roles_of(LEARNER) == {"candidate", "learner"}
    (record,) = audit.records
    assert (record.actor, record.action, record.subject, dict(record.details)) == ("system:invite", "role.granted", LEARNER,
                                                                                    {"role": "candidate", "via": "invite"})


def test_granting_the_candidate_role_twice_changes_nothing_the_second_time(sessions, roles, audit):
    add_user(sessions, LEARNER, "ada@example.com")
    roles.grant_candidate_role(LEARNER)
    assert roles.grant_candidate_role(LEARNER) is False
    assert held(sessions, LEARNER) == ["candidate", "learner"] and len(audit.records) == 1


@pytest.mark.parametrize("account_type", ["recruiter", "admin"])
def test_a_recruiter_or_admin_cannot_become_a_candidate_and_the_refusal_names_the_type(sessions, roles, audit, account_type):
    add_user(sessions, RECRUITER, "rec@example.com", account_type=account_type)
    with pytest.raises(RoleNotAllowed) as caught:
        roles.grant_candidate_role(RECRUITER)
    assert caught.value.account_type == account_type
    assert held(sessions, RECRUITER) == [] and audit.records == []


@pytest.mark.parametrize("status", ["disabled", "deleted"])
def test_an_unknown_or_inactive_account_gets_no_role(sessions, roles, status):
    add_user(sessions, LEARNER, "ada@example.com", status=status)
    with pytest.raises(UnknownUser):
        roles.grant_candidate_role(LEARNER)
    with pytest.raises(UnknownUser):
        roles.grant_candidate_role("u-ZZZZZZZZZZZZZZZZ")


# ---- changes by an admin (FR-ACC-05) ----------------------------------------------------------------------------------

def test_an_admin_grants_and_revokes_roles_and_every_change_is_audited(sessions, roles, audit):
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin")
    add_user(sessions, LEARNER, "ada@example.com", roles=())
    assert roles.grant(admin_scope(), LEARNER, "learner") is True and roles.grant(admin_scope(), LEARNER, "learner") is False
    assert roles.revoke(admin_scope(), LEARNER, "learner") is True and roles.revoke(admin_scope(), LEARNER, "learner") is False
    assert held(sessions, LEARNER) == []
    assert [(r.actor, r.action, r.subject, dict(r.details)) for r in audit.records] == [
        (ADMIN, "role.granted", LEARNER, {"role": "learner", "via": "admin"}),
        (ADMIN, "role.revoked", LEARNER, {"role": "learner"}),
    ]


def test_only_an_active_admin_may_change_roles(sessions, roles, audit):
    add_user(sessions, LEARNER, "ada@example.com", roles=())
    add_user(sessions, "u-BBBBBBBBBBBBBBBB", "bob@example.com")
    add_user(sessions, RECRUITER, "rec@example.com", account_type="recruiter")
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin", status="disabled")
    forged_admin = Scope(user_id="u-BBBBBBBBBBBBBBBB", roles=frozenset({Role.ADMIN}))  # a scope that claims admin for a participant
    for actor in (Scope(user_id="u-BBBBBBBBBBBBBBBB", roles=frozenset({Role.LEARNER})), forged_admin,
                  Scope(user_id=RECRUITER, roles=frozenset({Role.RECRUITER})), admin_scope(), admin_scope("u-NOBODYNOBODYNOBO")):
        with pytest.raises(NotAnAdmin):
            roles.grant(actor, LEARNER, "learner")
        with pytest.raises(NotAnAdmin):
            roles.revoke(actor, LEARNER, "learner")
    assert held(sessions, LEARNER) == [] and audit.records == []


def test_an_admin_cannot_give_a_recruiter_or_admin_a_participant_role_or_an_unknown_role(sessions, roles):
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin")
    add_user(sessions, RECRUITER, "rec@example.com", account_type="recruiter")
    add_user(sessions, LEARNER, "ada@example.com")
    for target in (RECRUITER, ADMIN):
        for role in ("learner", "candidate"):
            with pytest.raises(RoleNotAllowed):
                roles.grant(admin_scope(), target, role)
    for bad in ("admin", "recruiter", "", "Learner"):
        with pytest.raises(ValueError):
            roles.grant(admin_scope(), LEARNER, bad)


def test_taking_a_role_away_ends_the_persons_sessions(sessions, roles, session_service):
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin")
    add_user(sessions, LEARNER, "ada@example.com", roles=("learner", "candidate"))
    token = session_service.login(email="ada@example.com", password=PASSWORD).token
    assert session_service.resolve(token) is not None
    roles.revoke(admin_scope(), LEARNER, "candidate")
    assert session_service.resolve(token) is None, "no old session keeps a privilege that is gone"
    assert session_service.login(email="ada@example.com", password=PASSWORD).session.scope.roles == frozenset({Role.LEARNER})


def test_a_failing_audit_write_undoes_the_role_change(sessions, roles):
    add_user(sessions, LEARNER, "ada@example.com")

    class Broken:
        def append(self, **kw):
            raise RuntimeError("audit down")

    broken = RoleService(sessions, Broken())
    with pytest.raises(RuntimeError):
        broken.grant_candidate_role(LEARNER)
    assert held(sessions, LEARNER) == ["learner"]


# ---- admin creation (FR-ACC-11) ---------------------------------------------------------------------------------------

def test_the_seed_creates_an_admin_that_cannot_sign_in_yet(sessions, admins, audit, session_service):
    assert admins.seed_admin(email="Root@Example.com", display_name="Root", password=ADMIN_PASSWORD) is True
    with sessions() as s:
        user = s.scalar(select(User))
        assert (user.account_type, user.email_ci, user.status) == ("admin", "root@example.com", "active")
        assert user.email_verified_at is not None and user.password_hash.startswith("$argon2id$") and ADMIN_PASSWORD not in user.password_hash
        assert s.scalars(select(UserRole)).all() == [], "an admin holds no learner or candidate role"
    (record,) = audit.records
    assert (record.actor, record.action, record.subject, dict(record.details)) == ("system:seed", "admin.created", user.id, {"via": "seed"})
    assert ADMIN_PASSWORD not in repr(record)
    first_login = session_service.login(email="root@example.com", password=ADMIN_PASSWORD)  # allowed, but without the admin role until a second factor
    assert first_login.session.roles == frozenset() and first_login.session.user.account_type == "admin"


def test_seeding_the_same_address_again_changes_nothing(sessions, admins, audit):
    assert admins.seed_admin(email="root@example.com", display_name="Root", password=ADMIN_PASSWORD) is True
    assert admins.seed_admin(email="ROOT@example.com", display_name="Mallory", password="a second long admin pass 456") is False
    with sessions() as s:
        users = s.scalars(select(User)).all()
    assert len(users) == 1 and users[0].display_name == "Root" and len(audit.records) == 1


@pytest.mark.parametrize("kwargs,pointer", [
    ({"email": "nope", "display_name": "R", "password": ADMIN_PASSWORD}, "/email"),
    ({"email": "r@example.com", "display_name": " ", "password": ADMIN_PASSWORD}, "/display_name"),
    ({"email": "r@example.com", "display_name": "R", "password": "x" * 15}, "/password"),
    ({"email": "r@example.com", "display_name": "R", "password": "x" * 129}, "/password"),
])
def test_the_seed_refuses_bad_values_and_creates_nothing(sessions, admins, audit, kwargs, pointer):
    with pytest.raises(InvalidInput) as caught:
        admins.seed_admin(**kwargs)
    assert caught.value.pointer == pointer
    with sessions() as s:
        assert s.scalars(select(User)).all() == []
    assert audit.records == []


def mails(sessions):
    with sessions() as s:
        return [(r.template, r.to_user_id, dict(r.params)) for r in s.scalars(select(EmailOutbox))]


def test_an_admin_creates_another_who_gets_a_link_not_a_password(sessions, admins, audit):
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin")
    new_id = admins.create_admin(admin_scope(), email="Second@Example.com", display_name="Second Admin")
    with sessions() as s:
        user = s.get(User, new_id)
        assert (user.account_type, user.email_ci) == ("admin", "second@example.com") and user.email_verified_at is not None
        assert s.scalars(select(UserRole).where(UserRole.user_id == new_id)).all() == []
        (token_row,) = s.scalars(select(EmailToken).where(EmailToken.user_id == new_id)).all()
    ((template, to, params),) = mails(sessions)
    token = re.search(r"token=([A-Za-z0-9_-]{43})", params["link"]).group(1)
    assert (template, to) == ("account.admin_created", new_id) and params["link"].startswith(f"{ORIGIN}/reset-password?token=")
    assert token_row.purpose == "reset" and token_row.token_hash == security.token_hash(token) != token
    assert [(r.actor, r.action, r.subject, dict(r.details)) for r in audit.records] == [(ADMIN, "admin.created", new_id, {"via": "admin"})]
    assert token not in repr(audit.records)


def test_nobody_but_an_active_admin_can_create_an_admin(sessions, admins, audit):
    add_user(sessions, LEARNER, "ada@example.com")
    add_user(sessions, RECRUITER, "rec@example.com", account_type="recruiter")
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin", status="disabled")
    for actor in (Scope(user_id=LEARNER, roles=frozenset({Role.LEARNER})), Scope(user_id=LEARNER, roles=frozenset({Role.ADMIN})),
                  Scope(user_id=RECRUITER, roles=frozenset({Role.RECRUITER})), admin_scope(), admin_scope("u-NOBODYNOBODYNOBO")):
        with pytest.raises(NotAnAdmin):
            admins.create_admin(actor, email="x@example.com", display_name="X")
    with sessions() as s:
        assert [u.account_type for u in s.scalars(select(User))] == ["participant", "recruiter", "admin"]
    assert mails(sessions) == [] and audit.records == []


def test_creating_an_admin_for_a_known_address_is_refused_and_leaves_nothing(sessions, admins, audit):
    add_user(sessions, ADMIN, "admin@example.com", account_type="admin")
    add_user(sessions, LEARNER, "ada@example.com")
    with pytest.raises(EmailInUse):
        admins.create_admin(admin_scope(), email="ADA@example.com", display_name="X")
    assert mails(sessions) == [] and audit.records == []


def test_signup_never_makes_an_admin_whatever_the_request_says(sessions):
    service = AccountService(sessions, FakeSettingsPort(), public_origin=ORIGIN, now=lambda: T0)
    service.signup(email="new@example.com", password=PASSWORD, display_name="New")
    with sessions() as s:
        assert [u.account_type for u in s.scalars(select(User))] == ["participant"]


# ---- the seed command ------------------------------------------------------------------------------------------------

@pytest.fixture
def cli(sessions, monkeypatch):
    monkeypatch.setattr(seed_admin, "make_engine", lambda dsn: object())
    monkeypatch.setattr(seed_admin, "make_sessions", lambda engine, scope: sessions)
    monkeypatch.delenv("VULNMART_SEED_ADMIN_PASSWORD", raising=False)

    def run(*argv, stdin="", env_password=None, dsn="postgresql://app@db.invalid/vulnmart"):
        if env_password:
            monkeypatch.setenv("VULNMART_SEED_ADMIN_PASSWORD", env_password)
        out, err = io.StringIO(), io.StringIO()
        code = seed_admin.main(list(argv), settings=Settings(postgres_dsn=dsn), stdin=io.StringIO(stdin), out=out, err=err)
        return code, out.getvalue(), err.getvalue()

    return run


def test_the_command_takes_the_password_from_the_environment(sessions, cli, caplog):
    caplog.set_level(logging.DEBUG)
    code, out, err = cli("--email", "root@example.com", "--name", "Root", env_password=ADMIN_PASSWORD)
    assert code == 0 and "created" in out and ADMIN_PASSWORD not in out + err + caplog.text
    with sessions() as s:
        user = s.scalar(select(User))
    assert user.account_type == "admin" and security.verify_password(user.password_hash, ADMIN_PASSWORD)
    assert "admin.created" in caplog.text and "system:seed" in caplog.text, "the audit entry is also in the log until story P-17"


def test_the_command_takes_the_password_from_standard_input(sessions, cli):
    code, out, err = cli("--email", "root@example.com", "--name", "Root", "--password-stdin", stdin=ADMIN_PASSWORD + "\n")
    assert code == 0 and ADMIN_PASSWORD not in out + err
    with sessions() as s:
        assert security.verify_password(s.scalar(select(User.password_hash)), ADMIN_PASSWORD)


def test_without_a_password_the_command_makes_one_and_shows_it_once(sessions, cli):
    code, out, err = cli("--email", "root@example.com", "--name", "Root")
    shown = re.search(r"Password \(shown once, store it safely\): (\S+)", out).group(1)
    assert code == 0 and len(shown) >= 16 and shown not in err
    with sessions() as s:
        assert security.verify_password(s.scalar(select(User.password_hash)), shown)


def test_the_command_exit_codes(sessions, cli):
    assert cli("--email", "root@example.com", "--name", "Root", env_password=ADMIN_PASSWORD)[0] == 0
    code, out, err = cli("--email", "ROOT@example.com", "--name", "Root", env_password=ADMIN_PASSWORD)
    assert code == 3 and "exists already" in err
    code, out, err = cli("--email", "bad", "--name", "Root", env_password=ADMIN_PASSWORD)
    assert code == 2 and "email address is not valid" in err
    code, out, err = cli("--email", "b@example.com", "--name", "Root", "--password-stdin", stdin="short\n")
    assert code == 2 and "16 to 128" in err and "short" not in err
    code, out, err = cli("--email", "c@example.com", "--name", "Root", dsn="")
    assert code == 1 and "VULNMART_POSTGRES_DSN" in err
    with sessions() as s:
        assert len(s.scalars(select(User)).all()) == 1
    with pytest.raises(SystemExit):
        cli("--name", "no email")
