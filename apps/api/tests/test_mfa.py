"""Story P-15, the second factor at service level (FR-ACC-07): enrolment, the login challenge and its ticket, TOTP and recovery codes (each works once),
disabling, the admin rule, and what is stored (sealed secret, keyed hashes, no codes)."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
from vulnmart.accounts import security, totp
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.accounts.mfa import MfaInvalid, MfaService, MfaState, new_recovery_code
from vulnmart.accounts.models import EmailToken, MfaCredential, RecoveryCode, User, UserRole, UserSession
from vulnmart.accounts.roles import NotAnAdmin, RoleService
from vulnmart.accounts.self_service import SelfService, SessionEnded
from vulnmart.accounts.sessions import InvalidCredentials, LoginResult, MfaChallenge, SessionService
from vulnmart.kernel.db import Base
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role

T0 = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
PASSWORD = "correct horse battery staple"
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
_HASH = security.hash_password(PASSWORD)
USER = "u-AAAAAAAAAAAAAAAA"
ADMIN = "u-ADMINADMINADMIN2"


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def audit():
    return FakeAuditPort()


@pytest.fixture
def ss(sessions, clock):
    return SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=clock)


@pytest.fixture
def mfa(sessions, clock, audit, ss):
    return MfaService(sessions, KEYS, audit, ss, now=clock)


def add_user(sessions, uid=USER, email="ada@example.com", account_type="participant", roles=("learner",)):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email, password_hash=_HASH, display_name="Test", status="active",
                   email_verified_at=T0))
        s.flush()
        if account_type == "participant":
            s.add_all(UserRole(user_id=uid, role=role, account_type="participant") for role in roles)
    return uid


def secret_of(uri: str) -> str:
    return parse_qs(urlsplit(uri).query)["secret"][0]


def code(secret: str, clock, offset: int = 0) -> str:
    return totp.code_for(secret, totp.time_step(clock.now) + offset)


def enrol(sessions, ss, mfa, clock, uid=USER, email="ada@example.com"):
    """Sign in, enrol and confirm. Returns the secret, the recovery codes and the session value after confirming."""
    login = ss.login(email=email, password=PASSWORD)
    assert isinstance(login, LoginResult)
    secret = secret_of(mfa.start_enrolment(uid))
    token, codes = mfa.confirm_enrolment(user_id=uid, token=login.token, code=code(secret, clock))
    return secret, codes, token


def second_step(ss, mfa, uid=USER, email="ada@example.com"):
    challenge = ss.login(email=email, password=PASSWORD)
    assert isinstance(challenge, MfaChallenge) and challenge.user_id == uid
    return mfa.issue_ticket(uid)[0]


# ---- enrolment -------------------------------------------------------------------------------------------------------

def test_enrolment_stores_a_sealed_secret_and_is_pending_until_a_code_confirms_it(sessions, ss, mfa, clock):
    add_user(sessions)
    uri = mfa.start_enrolment(USER)
    secret = secret_of(uri)
    assert uri.startswith("otpauth://totp/VulnMart%3Aada%40example.com?secret=") and len(secret) == 32
    with sessions() as s:
        credential = s.get(MfaCredential, USER)
    assert credential.enabled_at is None and credential.last_used_step is None and secret not in credential.secret_enc
    assert KEYS.open(credential.secret_enc, account=USER) == secret
    assert ss.login(email="ada@example.com", password=PASSWORD).session.user.mfa_enabled is False, "a pending enrolment is not a second factor"


def test_starting_again_before_confirming_replaces_the_secret(sessions, mfa, clock):
    add_user(sessions)
    first, second = secret_of(mfa.start_enrolment(USER)), secret_of(mfa.start_enrolment(USER))
    assert first != second
    with sessions() as s:
        assert KEYS.open(s.get(MfaCredential, USER).secret_enc, account=USER) == second


def test_a_good_code_turns_it_on_shows_ten_recovery_codes_once_and_changes_the_session(sessions, ss, mfa, clock, audit):
    add_user(sessions)
    login = ss.login(email="ada@example.com", password=PASSWORD)
    secret = secret_of(mfa.start_enrolment(USER))
    token, codes = mfa.confirm_enrolment(user_id=USER, token=login.token, code=code(secret, clock))
    assert token != login.token and ss.resolve(login.token) is None, "the old session value is dead"
    resolved = ss.resolve(token)
    assert resolved.mfa_verified is True and resolved.user.mfa_enabled is True
    assert len(codes) == 10 and len(set(codes)) == 10 and all(re.fullmatch(r"[A-Z2-7]{10}", c) for c in codes)
    with sessions() as s:
        credential = s.get(MfaCredential, USER)
        stored = [r.code_hash for r in s.scalars(select(RecoveryCode))]
    assert credential.enabled_at is not None and credential.last_used_step == totp.time_step(clock.now)
    assert len(stored) == 10 and not set(codes) & set(stored) and all(len(h) == 64 for h in stored), "only keyed hashes are stored"
    assert [(r.actor, r.action, r.subject) for r in audit.records] == [(USER, "mfa.enabled", USER)]


def test_a_wrong_code_does_not_turn_it_on(sessions, ss, mfa, clock):
    add_user(sessions)
    login = ss.login(email="ada@example.com", password=PASSWORD)
    secret = secret_of(mfa.start_enrolment(USER))
    for bad in ("000000", code(secret, clock, 5), "12345"):
        with pytest.raises(MfaInvalid):
            mfa.confirm_enrolment(user_id=USER, token=login.token, code=bad)
    with sessions() as s:
        assert s.get(MfaCredential, USER).enabled_at is None and s.scalars(select(RecoveryCode)).all() == []
    assert ss.resolve(login.token) is not None, "the session was not changed"


def test_the_states_that_do_not_allow_enrolment_are_refused(sessions, ss, mfa, clock):
    add_user(sessions)
    login = ss.login(email="ada@example.com", password=PASSWORD)
    with pytest.raises(MfaState):
        mfa.confirm_enrolment(user_id=USER, token=login.token, code="123456")  # nothing was started
    secret, _, token = enrol(sessions, ss, mfa, clock)
    with pytest.raises(MfaState):
        mfa.start_enrolment(USER)  # already on
    with pytest.raises(MfaState):
        mfa.confirm_enrolment(user_id=USER, token=token, code=code(secret, clock, 1))  # already confirmed


def test_confirming_with_an_ended_session_changes_nothing(sessions, ss, mfa, clock):
    add_user(sessions)
    login = ss.login(email="ada@example.com", password=PASSWORD)
    secret = secret_of(mfa.start_enrolment(USER))
    ss.logout(login.token)
    with pytest.raises(SessionEnded):
        mfa.confirm_enrolment(user_id=USER, token=login.token, code=code(secret, clock))
    with sessions() as s:
        assert s.get(MfaCredential, USER).enabled_at is None


# ---- the login with a second factor ------------------------------------------------------------------------------------

def test_a_login_with_a_second_factor_has_no_session_until_the_code_is_given(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    with sessions.begin() as s:
        for row in s.scalars(select(UserSession)):
            s.delete(row)
        s.get(User, USER).last_login_at = None
    ticket = second_step(ss, mfa)
    with sessions() as s:
        assert s.scalars(select(UserSession)).all() == [] and s.get(User, USER).last_login_at is None, "no session and no login time yet"
    clock.advance(seconds=31)  # the code that confirmed the enrolment was this step's neighbour: use a newer one
    result = mfa.complete_login(ticket=ticket, code=code(secret, clock), ip_trunc="203.0.113.0/24", ua_class="browser")
    assert result.session.mfa_verified is True and result.session.user.mfa_enabled is True
    with sessions() as s:
        (row,) = s.scalars(select(UserSession)).all()
        assert row.mfa_at is not None and row.ip_trunc == "203.0.113.0/24" and s.get(User, USER).last_login_at is not None


def test_a_ticket_is_stored_as_a_hash_and_lasts_five_minutes(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    ticket, ends = mfa.issue_ticket(USER)
    assert ends == clock.now + timedelta(minutes=5) and re.fullmatch(r"[A-Za-z0-9_-]{43}", ticket)
    with sessions() as s:
        (row,) = s.scalars(select(EmailToken).where(EmailToken.purpose == "mfa")).all()
    assert row.token_hash == security.token_hash(ticket) != ticket
    clock.advance(minutes=5, seconds=1)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=ticket, code=code(secret, clock))


def test_a_ticket_works_once(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    ticket = second_step(ss, mfa)
    clock.advance(seconds=31)
    mfa.complete_login(ticket=ticket, code=code(secret, clock))
    clock.advance(seconds=31)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=ticket, code=code(secret, clock))


def test_five_wrong_codes_kill_the_ticket_even_for_the_right_code(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    ticket = second_step(ss, mfa)
    clock.advance(seconds=31)
    for _ in range(5):
        with pytest.raises(MfaInvalid) as caught:
            mfa.complete_login(ticket=ticket, code="000000")
        assert caught.value.user_id == USER, "the route can count the failure against the account"
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=ticket, code=code(secret, clock))


def test_an_unknown_ticket_is_the_same_error_without_a_user(sessions, ss, mfa, clock):
    add_user(sessions)
    enrol(sessions, ss, mfa, clock)
    with pytest.raises(MfaInvalid) as caught:
        mfa.complete_login(ticket=security.new_token(), code="123456")
    assert caught.value.user_id is None


def test_a_totp_code_cannot_be_used_twice_even_with_a_new_ticket(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    clock.advance(seconds=31)
    good = code(secret, clock)
    mfa.complete_login(ticket=second_step(ss, mfa), code=good)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=second_step(ss, mfa), code=good)  # an eavesdropper replays it
    clock.advance(seconds=30)
    mfa.complete_login(ticket=second_step(ss, mfa), code=code(secret, clock))  # the next step's code is fine


def test_the_code_that_confirmed_the_enrolment_cannot_be_replayed_at_login(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=second_step(ss, mfa), code=code(secret, clock))


def test_a_recovery_code_logs_in_once_and_only_for_its_own_account(sessions, ss, mfa, clock, audit):
    add_user(sessions)
    add_user(sessions, "u-BBBBBBBBBBBBBBBB", "bob@example.com")
    _, codes, _ = enrol(sessions, ss, mfa, clock)
    _, other_codes, _ = enrol(sessions, ss, mfa, clock, "u-BBBBBBBBBBBBBBBB", "bob@example.com")
    result = mfa.complete_login(ticket=second_step(ss, mfa), code=codes[0])
    assert result.session.mfa_verified is True
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=second_step(ss, mfa), code=codes[0])  # used
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=second_step(ss, mfa), code=other_codes[0])  # another account's code
    mfa.complete_login(ticket=second_step(ss, mfa), code=codes[1])  # the others still work
    assert [r.action for r in audit.records].count("mfa.recovery_code_used") == 2
    for bad in ("abcdefghij", "ABCDEFGHI", "ABCDEFGHIJK", "1234567"):
        with pytest.raises(MfaInvalid):
            mfa.complete_login(ticket=second_step(ss, mfa), code=bad)


def test_two_requests_with_one_code_open_one_session(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    clock.advance(seconds=31)
    first, second = second_step(ss, mfa), second_step(ss, mfa)
    good = code(secret, clock)
    mfa.complete_login(ticket=first, code=good)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=second, code=good)


def test_a_disabled_account_cannot_finish_a_login(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    ticket = second_step(ss, mfa)
    with sessions.begin() as s:
        s.get(User, USER).status = "disabled"
    clock.advance(seconds=31)
    with pytest.raises(MfaInvalid):
        mfa.complete_login(ticket=ticket, code=code(secret, clock))


# ---- turning it off --------------------------------------------------------------------------------------------------

def test_a_recruiter_turns_it_off_with_the_password_and_the_session_changes(sessions, ss, mfa, clock, audit):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    _, _, token = enrol(sessions, ss, mfa, clock, "u-RRRRRRRRRRRRRRRR", "rec@example.com")
    with pytest.raises(InvalidCredentials):
        mfa.disable(user_id="u-RRRRRRRRRRRRRRRR", token=token, password="not the password at all")
    new = mfa.disable(user_id="u-RRRRRRRRRRRRRRRR", token=token, password=PASSWORD)
    assert new != token and ss.resolve(token) is None
    resolved = ss.resolve(new)
    assert resolved.user.mfa_enabled is False and resolved.mfa_verified is False
    with sessions() as s:
        assert s.get(MfaCredential, "u-RRRRRRRRRRRRRRRR") is None and s.scalars(select(RecoveryCode)).all() == []
    assert isinstance(ss.login(email="rec@example.com", password=PASSWORD), LoginResult), "no second step any more"
    assert [r.action for r in audit.records] == ["mfa.enabled", "mfa.disabled"]


def test_nothing_to_turn_off_and_an_admin_cannot_turn_it_off(sessions, ss, mfa, clock):
    add_user(sessions)
    login = ss.login(email="ada@example.com", password=PASSWORD)
    with pytest.raises(MfaState):
        mfa.disable(user_id=USER, token=login.token, password=PASSWORD)  # not enabled
    add_user(sessions, ADMIN, "admin@example.com", "admin")
    _, _, token = enrol(sessions, ss, mfa, clock, ADMIN, "admin@example.com")
    with pytest.raises(MfaState):
        mfa.disable(user_id=ADMIN, token=token, password=PASSWORD)
    with sessions() as s:
        assert s.get(MfaCredential, ADMIN).enabled_at is not None


# ---- admins (FR-ACC-07) ----------------------------------------------------------------------------------------------

def test_an_admin_holds_the_admin_role_only_after_proving_a_second_factor(sessions, ss, mfa, clock, audit):
    add_user(sessions, ADMIN, "admin@example.com", "admin")
    add_user(sessions, USER, "ada@example.com", roles=())
    roles = RoleService(sessions, audit, ss)
    first = ss.login(email="admin@example.com", password=PASSWORD)
    assert Role.ADMIN not in first.session.roles, "the first sign-in can only enrol"
    with pytest.raises(NotAnAdmin):
        roles.grant(first.session.scope, USER, "learner")  # an admin function, refused to an admin who has not proved a second factor
    secret = secret_of(mfa.start_enrolment(ADMIN))
    token, _ = mfa.confirm_enrolment(user_id=ADMIN, token=first.token, code=code(secret, clock))
    proved = ss.resolve(token)
    assert Role.ADMIN in proved.roles and proved.scope.is_admin and proved.user.mfa_enabled
    assert ss.resolve(first.token) is None
    assert roles.grant(proved.scope, USER, "learner") is True, "the same function works once the factor is proved"
    # the next login needs the second step, and the session after it is an admin session again
    clock.advance(seconds=31)
    result = mfa.complete_login(ticket=second_step(ss, mfa, ADMIN, "admin@example.com"), code=code(secret, clock))
    assert Role.ADMIN in result.session.roles and result.session.mfa_verified


def test_an_admin_session_made_without_a_proved_factor_never_has_the_admin_role(sessions, ss, clock):
    add_user(sessions, ADMIN, "admin@example.com", "admin")
    token = security.new_token()
    with sessions.begin() as s:
        s.add(UserSession(id_hash=security.token_hash(token), user_id=ADMIN, last_seen_at=T0, absolute_expires_at=T0 + timedelta(hours=12), mfa_at=None))
    assert ss.resolve(token).roles == frozenset() and ss.resolve(token).mfa_verified is False


def test_rotation_keeps_or_sets_the_second_factor_mark_as_asked(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, token = enrol(sessions, ss, mfa, clock)
    kept = ss.rotate(token)
    assert ss.resolve(kept).mfa_verified is True, "a plain rotation keeps the mark"
    with sessions.begin() as s:
        cleared = ss.rotate_in(s, kept, mfa=False)
    assert ss.resolve(cleared).mfa_verified is False


def test_the_profile_answer_shows_the_real_second_factor_flag(sessions, ss, mfa, clock):
    add_user(sessions)
    me = SelfService(sessions, ss)
    assert me.update_profile(USER, display_name="Ada").mfa_enabled is False
    enrol(sessions, ss, mfa, clock)
    assert me.update_profile(USER, display_name="Ada L").mfa_enabled is True


def test_recovery_codes_have_48_bits_and_the_contract_shape():
    codes = {new_recovery_code() for _ in range(200)}
    assert len(codes) == 200 and all(re.fullmatch(r"[A-Z2-7]{10}", c) for c in codes)

def test_a_verification_or_reset_link_is_not_a_login_ticket_and_a_ticket_is_not_a_link(sessions, ss, mfa, clock):
    add_user(sessions)
    secret, _, _ = enrol(sessions, ss, mfa, clock)
    clock.advance(seconds=31)
    for purpose in ("verify", "reset"):
        link = security.new_token()
        with sessions.begin() as s:
            s.add(EmailToken(token_hash=security.token_hash(link), user_id=USER, purpose=purpose, expires_at=clock.now + timedelta(hours=1)))
        with pytest.raises(MfaInvalid):
            mfa.complete_login(ticket=link, code=code(secret, clock))  # a mailed link must not open a login
    ticket = second_step(ss, mfa)
    from vulnmart.accounts.service import AccountService, TokenInvalid

    accounts = AccountService(sessions, FakeSettingsPort(), public_origin="https://vulnmart.example", now=clock)
    for use in (lambda: accounts.verify_email(ticket), lambda: accounts.confirm_reset(token=ticket, new_password="purple tractor midnight lantern")):
        with pytest.raises(TokenInvalid):
            use()  # and a login ticket must not verify an address or reset a password
    with sessions() as s:
        assert s.scalar(select(EmailToken.used_at).where(EmailToken.token_hash == security.token_hash(ticket))) is None, "the ticket is untouched"
