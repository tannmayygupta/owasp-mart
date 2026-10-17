"""Story P-11: learner signup, email verification and resending the link (FR-ACC-01, FR-ACC-02) at service level, on SQLite."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.models import EmailToken, User, UserRole
from vulnmart.accounts.service import AccountService, DbRecipients, InvalidInput, TokenInvalid, clean_display_name
from vulnmart.kernel.db import Base
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeSettingsPort

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
GOOD = "correct horse battery staple"
ORIGIN = "https://vulnmart.example"


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def service(sessions, clock):
    return AccountService(sessions, FakeSettingsPort(), public_origin=ORIGIN, now=clock)


def mails(sessions):
    with sessions() as s:
        return [(r.template, r.to_user_id, dict(r.params)) for r in s.scalars(select(EmailOutbox).order_by(EmailOutbox.id))]


def users(sessions):
    with sessions() as s:
        return s.scalars(select(User)).all()


def token_of(mail_params) -> str:
    return re.search(r"token=([A-Za-z0-9_-]+)", mail_params["link"]).group(1)


# ---- security helpers ------------------------------------------------------------------------------------------------

def test_passwords_are_argon2id_with_a_salt_and_verify_in_both_directions():
    first, second = security.hash_password(GOOD), security.hash_password(GOOD)
    assert first.startswith("$argon2id$v=19$m=19456,t=2,p=1$") and first != second, "a new salt each time"
    assert security.verify_password(first, GOOD) and not security.verify_password(first, GOOD + "x")
    assert not security.verify_password("not a hash", GOOD) and not security.verify_password("", GOOD)
    assert not security.needs_rehash(first)


def test_ids_and_tokens_have_the_contract_shapes():
    assert re.fullmatch(r"u-[A-Z2-7]{16}", security.new_user_id())
    token = security.new_token()
    assert re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token) and len(security.token_hash(token)) == 64
    assert security.new_token() != token and security.token_hash(token) != token


@pytest.mark.parametrize("raw,expected", [
    ("Ada@Example.COM", "ada@example.com"), ("  ada@example.com ", "ada@example.com"), ("ada+tag@example.com", "ada+tag@example.com"),
    ("ａｄａ@example.com", "ada@example.com"),  # full-width letters fold to the same address
])
def test_email_normalisation(raw, expected):
    assert security.normalize_email(raw) == expected


@pytest.mark.parametrize("raw", ["", "a@b", "no-at.example.com", "a b@example.com", "a@@example.com", "x" * 250 + "@e.co", "a@e.com\r\nBcc: x@e.com"])
def test_bad_addresses_are_rejected(raw):
    assert security.normalize_email(raw) is None


def test_display_names_are_cleaned_and_bounded():
    assert clean_display_name("  Ada \t Lovelace\r\n") == "Ada Lovelace"
    for bad in ("", "   ", "x" * 61, "\x00\x01"):
        with pytest.raises(InvalidInput):
            clean_display_name(bad)


# ---- signup ----------------------------------------------------------------------------------------------------------

def test_signup_creates_an_unverified_learner_and_queues_the_verification_mail(service, sessions):
    service.signup(email="Ada@Example.com", password=GOOD, display_name="Ada")
    (user,) = users(sessions)
    assert (user.account_type, user.status, user.email, user.email_ci) == ("participant", "active", "Ada@Example.com", "ada@example.com")
    assert user.email_verified_at is None and user.age_declared_at is not None and re.fullmatch(r"u-[A-Z2-7]{16}", user.id)
    assert user.password_hash.startswith("$argon2id$") and GOOD not in user.password_hash
    with sessions() as s:
        assert [r.role for r in s.scalars(select(UserRole))] == ["learner"]
        (stored,) = s.scalars(select(EmailToken)).all()
    ((template, to, params),) = mails(sessions)
    assert (template, to) == ("account.verify", user.id) and params["expires_in_hours"] == 24
    token = token_of(params)
    assert params["link"] == f"{ORIGIN}/verify-email?token={token}"
    assert stored.token_hash == security.token_hash(token) and stored.token_hash != token, "only the hash is stored"
    assert stored.purpose == "verify" and stored.used_at is None and stored.expires_at.replace(tzinfo=UTC) == T0 + timedelta(hours=24)


def test_a_known_address_gets_the_already_registered_mail_and_no_second_account(service, sessions):
    service.signup(email="ada@example.com", password=GOOD, display_name="Ada")
    service.signup(email="ADA@example.com", password="another long password", display_name="Mallory")
    (user,) = users(sessions)
    assert user.display_name == "Ada", "the second signup changed nothing"
    assert [(t, u) for t, u, _ in mails(sessions)] == [("account.verify", user.id), ("account.already_registered", user.id)]
    with sessions() as s:
        assert s.scalars(select(EmailToken)).all().__len__() == 1


def test_the_callers_see_the_same_result_for_new_and_known_addresses(service):
    assert service.signup(email="new@example.com", password=GOOD, display_name="N") is None
    assert service.signup(email="new@example.com", password=GOOD, display_name="N") is None


def test_a_disabled_account_gets_no_mail_and_is_not_recreated(service, sessions):
    service.signup(email="ada@example.com", password=GOOD, display_name="Ada")
    with sessions.begin() as s:
        s.scalar(select(User)).status = "disabled"
    service.signup(email="ada@example.com", password=GOOD, display_name="Ada")
    assert len(mails(sessions)) == 1 and len(users(sessions)) == 1


@pytest.mark.parametrize("kwargs,pointer", [
    ({"email": "nope", "password": GOOD, "display_name": "A"}, "/email"),
    ({"email": "a@example.com", "password": "eleven-chrs", "display_name": "A"}, "/password"),
    ({"email": "a@example.com", "password": "x" * 129, "display_name": "A"}, "/password"),
    ({"email": "a@example.com", "password": GOOD, "display_name": " "}, "/display_name"),
])
def test_invalid_input_is_refused_and_leaves_nothing(service, sessions, kwargs, pointer):
    with pytest.raises(InvalidInput) as caught:
        service.signup(**kwargs)
    assert caught.value.pointer == pointer
    assert users(sessions) == [] and mails(sessions) == []


def test_the_eleven_character_boundary(service, sessions):
    with pytest.raises(InvalidInput):
        service.signup(email="a@example.com", password="abcdefghijk", display_name="A")
    service.signup(email="a@example.com", password="abcdefghijkl", display_name="A")
    assert len(users(sessions)) == 1


# ---- verification ----------------------------------------------------------------------------------------------------

def verify_link(service, sessions, email="ada@example.com"):
    service.signup(email=email, password=GOOD, display_name="Ada")
    return token_of(mails(sessions)[-1][2])


def test_a_link_verifies_the_address_once(service, sessions, clock):
    token = verify_link(service, sessions)
    clock.now += timedelta(hours=1)
    service.verify_email(token)
    (user,) = users(sessions)
    assert user.email_verified_at is not None and user.email_verified_at.replace(tzinfo=UTC) == clock.now
    with pytest.raises(TokenInvalid):
        service.verify_email(token)
    with sessions() as s:
        assert s.scalar(select(EmailToken)).used_at is not None


def test_an_expired_unknown_or_foreign_token_is_the_same_error(service, sessions, clock):
    token = verify_link(service, sessions)
    clock.now += timedelta(hours=24, seconds=1)
    for candidate in (token, security.new_token()):
        with pytest.raises(TokenInvalid):
            service.verify_email(candidate)
    assert users(sessions)[0].email_verified_at is None
    with sessions.begin() as s:  # a reset token must not verify an address
        s.add(EmailToken(token_hash=security.token_hash("r" * 43), user_id=users(sessions)[0].id, purpose="reset",
                         expires_at=clock.now + timedelta(hours=1)))
    with pytest.raises(TokenInvalid):
        service.verify_email("r" * 43)


def test_the_token_is_valid_until_the_moment_it_expires(service, sessions, clock):
    token = verify_link(service, sessions)
    clock.now += timedelta(hours=23, minutes=59)
    service.verify_email(token)
    assert users(sessions)[0].email_verified_at is not None


def test_a_disabled_account_cannot_verify_and_the_token_is_not_used_up(service, sessions):
    token = verify_link(service, sessions)
    with sessions.begin() as s:
        s.scalar(select(User)).status = "disabled"
    with pytest.raises(TokenInvalid):
        service.verify_email(token)
    with sessions() as s:
        assert s.scalar(select(EmailToken)).used_at is None


# ---- resend ----------------------------------------------------------------------------------------------------------

def test_resend_kills_the_old_link_and_sends_a_new_one(service, sessions):
    first = verify_link(service, sessions)
    service.resend_verification(email="ADA@example.com")
    second = token_of(mails(sessions)[-1][2])
    assert second != first and len(mails(sessions)) == 2
    with pytest.raises(TokenInvalid):
        service.verify_email(first)
    service.verify_email(second)
    assert users(sessions)[0].email_verified_at is not None


def test_resend_is_silent_for_verified_unknown_and_disabled_accounts(service, sessions):
    token = verify_link(service, sessions)
    service.verify_email(token)
    service.resend_verification(email="ada@example.com")  # already verified
    service.resend_verification(email="nobody@example.com")  # no such account
    assert len(mails(sessions)) == 1
    with pytest.raises(InvalidInput):
        service.resend_verification(email="not an address")


def test_the_mail_worker_finds_the_address_of_an_active_account_only(service, sessions):
    service.signup(email="ada@example.com", password=GOOD, display_name="Ada")
    (user,) = users(sessions)
    lookup = DbRecipients(sessions)
    assert lookup.address_for(user.id) == "ada@example.com"
    assert lookup.address_for("u-AAAAAAAAAAAAAAAA") is None
    with sessions.begin() as s:
        s.scalar(select(User)).status = "deleted"
    assert lookup.address_for(user.id) is None


def test_a_mail_is_queued_with_its_cause_or_not_at_all(service, sessions, monkeypatch):
    """If anything fails after the account is added (here: the queue), the account is not left behind."""
    def broken(self, **kwargs):
        raise RuntimeError("queue down")

    monkeypatch.setattr("vulnmart.notifications.service.DbOutboxPort.enqueue_email", broken)
    with pytest.raises(RuntimeError):
        service.signup(email="ada@example.com", password=GOOD, display_name="Ada")
    assert users(sessions) == [] and mails(sessions) == []
