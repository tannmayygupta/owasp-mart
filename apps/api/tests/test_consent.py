"""Story P-16 (FR-PRV-01, FR-PRV-02): the consent notice, the append-only record and its three routes (getConsentNotice, recordConsent, listMyConsents).

The service and the routes run on in-memory SQLite here; the rules only Postgres can show (the app role cannot change or delete a record, two
simultaneous clicks write one record) are in test_privacy_postgres.py."""
from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.privacy import notice as notice_module
from vulnmart.privacy.consent import ConsentNotFound, ConsentService, ConsentStale, ConsentState, new_consent_id
from vulnmart.privacy.models import ConsentRecord
from vulnmart.privacy.notice import NOTICE_VERSION, NoticeError, check_template, render
from vulnmart.privacy.targets import ConsentTargets, FakeConsentTargets

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "correct horse battery staple"
T0 = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
_HASH = security.hash_password(PASSWORD)
ALICE, BOB = "u-AAAAAAAAAAAAAAAA", "u-BBBBBBBBBBBBBBBB"
A1, A2, A3 = "a-AAAAAAAAAAAAAAAA", "a-BBBBBBBBBBBBBBBB", "a-CCCCCCCCCCCCCCCC"


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
def targets():
    t = FakeConsentTargets()
    t.add(attempt_id=A1, user_id=ALICE, company_name="Acme Security Ltd")
    t.add(attempt_id=A2, user_id=ALICE, company_name="Globex")
    t.add(attempt_id=A3, user_id=BOB, company_name="Initech")
    return t


@pytest.fixture
def audit():
    return FakeAuditPort()


@pytest.fixture
def service(sessions, targets, audit, clock):
    return ConsentService(sessions, targets, audit, FakeSettingsPort(), KEYS, now=clock)


def shown(service, user=ALICE, attempt=A1):
    return service.notice(user, attempt)[1]


def decide(service, decision="granted", *, user=ALICE, attempt=A1, ip="203.0.113.7", agent="Mozilla/5.0 Test", notice=None):
    n = notice or shown(service, user, attempt)
    return service.record(user_id=user, attempt_id=attempt, notice_version=n.version, notice_sha256=n.sha256, decision=decision, ip=ip, user_agent=agent)


def rows(sessions):
    with sessions() as s:
        return s.scalars(select(ConsentRecord).order_by(ConsentRecord.at, ConsentRecord.id)).all()


# ---- the notice ------------------------------------------------------------------------------------------------------

def test_the_notice_text_is_the_one_pinned_for_its_version():
    check_template()
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d{1,3}", NOTICE_VERSION)


def test_a_changed_text_without_a_new_version_is_refused(monkeypatch, sessions, targets, audit):
    monkeypatch.setitem(notice_module.TEMPLATE_HASHES, NOTICE_VERSION, "0" * 64)
    with pytest.raises(NoticeError):
        check_template()
    with pytest.raises(NoticeError):  # and the service does not start with it
        ConsentService(sessions, targets, audit, FakeSettingsPort(), KEYS)


def test_the_hash_is_over_the_exact_text_and_the_markers_are_filled():
    n = render(company_name="Acme Security Ltd", retention_days=180, record_months=12)
    assert n.sha256 == hashlib.sha256(n.text.encode("utf-8")).hexdigest() and n.version == NOTICE_VERSION
    assert "{{" not in n.text and "}}" not in n.text
    assert "Acme Security Ltd decides how the results are used" in n.text
    assert "180 days" in n.text and "12 months" in n.text
    assert not any(line.startswith("#") for line in n.text.splitlines()), "the comment lines of the file are never shown"
    assert render(company_name="Acme Security Ltd", retention_days=90, record_months=12).sha256 != n.sha256, "another retention is another text"
    assert render(company_name="Globex", retention_days=180, record_months=12).sha256 != n.sha256


def test_the_notice_says_what_fr_prv_01_requires():
    text = render(company_name="Acme", retention_days=180, record_months=12).text
    for needed in ("Your name and email address", "Your answers and write-ups", "capture a flag", "Times", "hints", "IP address and browser type",
                   "Your screen, your webcam or your microphone", "outside the test shop", "Why", "Who sees it", "How long it is kept",
                   "see your data", "download it", "deleted", "withdraw your consent", "one click", "real password or real personal data", "18 or over",
                   "Acme decides how the results are used"):
        assert needed in text, needed


@pytest.mark.parametrize("name", ["", "   ", "x" * 121, "Acme\x00Ltd", "A\u0007B"])
def test_an_unusable_company_name_is_refused(name):
    with pytest.raises(NoticeError):
        render(company_name=name, retention_days=180, record_months=12)


def test_a_company_name_cannot_add_a_paragraph_or_carry_a_marker():
    n = render(company_name="Acme\nLtd {{retention_days}}", retention_days=180, record_months=12)
    assert n.company_name == "Acme Ltd {{retention_days}}" and "\nLtd" not in n.text
    assert n.text.count("{{retention_days}}") >= 1, "a marker in a name is shown as written, not filled in"


def test_the_retention_shown_comes_from_the_settings(sessions, targets, audit, clock):
    settings = FakeSettingsPort({"candidate_retention_days": 90, "consent_record_extra_months": 6})
    n = ConsentService(sessions, targets, audit, settings, KEYS, now=clock).notice(ALICE, A1)[1]
    assert n.retention_days_shown == 90 and "90 days" in n.text and "6 months" in n.text


# ---- the record ------------------------------------------------------------------------------------------------------

def test_a_grant_writes_one_record_with_everything_fr_prv_02_lists_and_moves_the_attempt_on(service, sessions, audit, targets):
    n = shown(service)
    view = decide(service, "granted", notice=n)
    assert re.fullmatch(r"k-[A-Z2-7]{16}", view.consent_id) and view.decision == "granted" and view.recorded_at == T0
    [row] = rows(sessions)
    assert (row.id, row.user_id, row.attempt_id, row.action, row.method) == (view.consent_id, ALICE, A1, "granted", "web")
    assert (row.org_id, row.template_id) == ("o-ORG", "t-TEMPLATE")
    assert (row.notice_version, row.notice_text_sha256, row.notice_text_snapshot) == (n.version, n.sha256, n.text)
    assert hashlib.sha256(row.notice_text_snapshot.encode()).hexdigest() == row.notice_text_sha256, "the stored snapshot is the text the hash is of"
    assert (row.retention_days_shown, row.controller_name_shown) == (180, "Acme Security Ltd")
    assert re.fullmatch(r"[0-9a-f]{64}", row.ip_hash) and re.fullmatch(r"[0-9a-f]{64}", row.ua_hash) and row.ip_hash != row.ua_hash
    assert "203.0.113.7" not in str(row.__dict__) and "Mozilla" not in str(row.__dict__), "neither the address nor the browser string is stored"
    assert row.ip_hash == KEYS.context_hash("ip", "203.0.113.7") and row.ua_hash == KEYS.context_hash("ua", "Mozilla/5.0 Test")
    assert targets.find(A1).state == "ready" and targets.applied == [(A1, "granted", view.consent_id)]
    [entry] = audit.records
    assert row.audit_seq == entry.seq == 1 and entry.action == "consent.granted" and entry.actor == ALICE and entry.subject == ALICE
    assert entry.details == {"consent": view.consent_id, "attempt": A1, "org": "o-ORG", "notice_version": n.version, "notice_sha256": n.sha256}


def test_a_decline_writes_a_declined_record_and_ends_the_attempt(service, sessions, audit, targets):
    view = decide(service, "declined")
    assert view.decision == "declined" and [r.action for r in rows(sessions)] == ["declined"]
    assert targets.find(A1).state == "cancelled" and audit.records[0].action == "consent.declined"


def test_a_missing_address_or_browser_is_stored_as_nothing_not_as_a_hash_of_nothing(service, sessions):
    decide(service, ip=None, agent=None)
    [row] = rows(sessions)
    assert row.ip_hash is None and row.ua_hash is None


def test_a_very_long_browser_string_is_cut_before_it_is_hashed(service, sessions):
    decide(service, agent="A" * 5000)
    assert rows(sessions)[0].ua_hash == KEYS.context_hash("ua", "A" * 300)


def test_a_stale_text_is_refused_and_nothing_is_written(service, sessions, audit, targets):
    n = shown(service)
    for version, digest in ((n.version, "0" * 64), ("2020-01-01.1", n.sha256), (n.version, n.sha256.upper())):
        with pytest.raises(ConsentStale):
            service.record(user_id=ALICE, attempt_id=A1, notice_version=version, notice_sha256=digest, decision="granted", ip=None, user_agent=None)
    assert rows(sessions) == [] and audit.records == [] and targets.find(A1).state == "consent"


def test_the_hash_of_another_attempts_text_is_stale_here(service):
    other = shown(service, ALICE, A2)  # another company, another text
    with pytest.raises(ConsentStale):
        decide(service, attempt=A1, notice=other)


def test_someone_elses_or_an_unknown_attempt_is_not_found(service, sessions, audit):
    n = shown(service)
    for attempt in (A3, "a-ZZZZZZZZZZZZZZZZ"):
        with pytest.raises(ConsentNotFound):
            service.notice(ALICE, attempt)
        with pytest.raises(ConsentNotFound):
            service.record(user_id=ALICE, attempt_id=attempt, notice_version=n.version, notice_sha256=n.sha256, decision="granted", ip=None, user_agent=None)
    assert rows(sessions) == [] and audit.records == []


@pytest.mark.parametrize("state", ["invited", "ready", "running", "submitted", "withdrawn", "cancelled", "deleted"])
def test_only_an_attempt_in_state_consent_can_be_decided(sessions, audit, clock, state):
    t = FakeConsentTargets()
    t.add(attempt_id=A1, user_id=ALICE, state=state)
    s = ConsentService(sessions, t, audit, FakeSettingsPort(), KEYS, now=clock)
    n = render(company_name="Example Company Ltd", retention_days=180, record_months=12)
    with pytest.raises(ConsentState):
        s.notice(ALICE, A1)
    with pytest.raises(ConsentState):
        s.record(user_id=ALICE, attempt_id=A1, notice_version=n.version, notice_sha256=n.sha256, decision="granted", ip=None, user_agent=None)
    assert rows(sessions) == [] and audit.records == []


def test_the_same_decision_twice_is_one_record_and_the_opposite_is_a_conflict(service, sessions, audit, targets):
    first = decide(service, "granted")
    again = decide(service, "granted", notice=render(company_name="Acme Security Ltd", retention_days=180, record_months=12))
    assert again == first and len(rows(sessions)) == 1 and len(audit.records) == 1
    with pytest.raises(ConsentState):
        decide(service, "declined", notice=render(company_name="Acme Security Ltd", retention_days=180, record_months=12))
    assert [r.action for r in rows(sessions)] == ["granted"] and targets.find(A1).state == "ready"


def test_a_repeat_after_the_text_changed_is_still_the_same_record(service, sessions):
    first = decide(service, "granted")
    again = service.record(user_id=ALICE, attempt_id=A1, notice_version="2099-01-01.1", notice_sha256="f" * 64, decision="granted", ip=None, user_agent=None)
    assert again == first and len(rows(sessions)) == 1


def test_a_failure_between_the_record_and_the_move_is_finished_by_repeating_the_request(service, sessions, audit, targets):
    targets.fail_next = 1
    with pytest.raises(RuntimeError):
        decide(service, "granted")
    assert len(rows(sessions)) == 1 and targets.find(A1).state == "consent", "the record exists, the attempt has not moved"
    done = decide(service, "granted", notice=render(company_name="Acme Security Ltd", retention_days=180, record_months=12))
    assert done.consent_id == rows(sessions)[0].id and len(rows(sessions)) == 1 and len(audit.records) == 1
    assert targets.find(A1).state == "ready" and targets.applied == [(A1, "granted", done.consent_id)]


def test_a_decision_other_than_granted_or_declined_is_refused(service):
    with pytest.raises(ValueError):
        service.record(user_id=ALICE, attempt_id=A1, notice_version="x", notice_sha256="x", decision="withdrawn", ip=None, user_agent=None)


def test_list_is_the_callers_own_newest_first_with_has_more(service, clock):
    decide(service, "granted", attempt=A1)
    clock.advance(minutes=1)
    decide(service, "declined", attempt=A2)
    clock.advance(minutes=1)
    decide(service, "granted", user=BOB, attempt=A3)
    items, more = service.list_mine(ALICE, 50)
    assert [(i.attempt_id, i.decision) for i in items] == [(A2, "declined"), (A1, "granted")] and more is False
    one, more = service.list_mine(ALICE, 1)
    assert [i.attempt_id for i in one] == [A2] and more is True
    assert [i.attempt_id for i in service.list_mine(BOB, 50)[0]] == [A3]
    assert service.list_mine("u-CCCCCCCCCCCCCCCC", 50) == ([], False)


def test_consent_ids_are_random_and_in_the_contract_format():
    ids = {new_consent_id() for _ in range(200)}
    assert len(ids) == 200 and all(re.fullmatch(r"k-[A-Z2-7]{16}", i) for i in ids)


def test_the_fake_targets_satisfy_the_port():
    assert isinstance(FakeConsentTargets(), ConsentTargets)


# ---- the routes ------------------------------------------------------------------------------------------------------

def add_user(sessions, uid, email):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="participant", email=email, email_ci=email, password_hash=_HASH, display_name="T", status="active", email_verified_at=T0))
        s.flush()
        s.add(UserRole(user_id=uid, role="candidate", account_type="participant"))


def make_app(sessions, clock, service, settings=None):
    settings = settings or FakeSettingsPort()
    ss = SessionService(sessions, settings, b"k" * 32, now=clock)
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=PasswordPolicy(),
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock), sessions=ss, self_service=SelfService(sessions, ss),
                     consent=service)
    app.state.ports.settings = settings
    return app


def client(app) -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


def sign_in(c, email="alice@example.com"):
    r = c.post("/api/v1/session", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"x-csrf-token": r.json()["csrf_token"]}


@pytest.fixture
def web(sessions, clock, service):
    add_user(sessions, ALICE, "alice@example.com")
    add_user(sessions, BOB, "bob@example.com")
    with client(make_app(sessions, clock, service)) as c:
        yield c


def test_the_routes_need_a_session(sessions, clock, service):
    with client(make_app(sessions, clock, service)) as c:
        for r in (c.get(f"/api/v1/consent/notice?attempt_id={A1}"), c.get("/api/v1/me/consents"),
                  c.post("/api/v1/consent", json={"attempt_id": A1, "notice_version": "2026-10-18.1", "notice_text_sha256": "0" * 64, "decision": "granted"})):
            assert r.status_code == 401 and r.json()["code"] == "AUTH-SESSION-REQUIRED"


def test_the_notice_route_answers_the_contract_shape(web):
    sign_in(web)
    r = web.get(f"/api/v1/consent/notice?attempt_id={A1}")
    body = r.json()
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    assert set(body) == {"attempt_id", "notice_version", "notice_text", "notice_text_sha256", "retention_days_shown", "company_name"}
    assert body["attempt_id"] == A1 and body["company_name"] == "Acme Security Ltd" and body["retention_days_shown"] == 180
    assert hashlib.sha256(body["notice_text"].encode()).hexdigest() == body["notice_text_sha256"] and "Acme Security Ltd" in body["notice_text"]


@pytest.mark.parametrize("attempt", [A3, "a-ZZZZZZZZZZZZZZZZ"])
def test_the_notice_of_someone_elses_or_an_unknown_attempt_is_404(web, attempt):
    sign_in(web)
    r = web.get(f"/api/v1/consent/notice?attempt_id={attempt}")
    assert (r.status_code, r.json()["code"]) == (404, "ATT-NOT-FOUND")


@pytest.mark.parametrize("attempt", ["", "a-short", "x-AAAAAAAAAAAAAAAA", "a-aaaaaaaaaaaaaaaa", f"{A1}extra"])
def test_a_malformed_attempt_id_is_422(web, attempt):
    sign_in(web)
    r = web.get("/api/v1/consent/notice", params={"attempt_id": attempt})
    assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION"


def test_the_notice_of_an_attempt_not_in_state_consent_is_409(sessions, clock, audit):
    t = FakeConsentTargets()
    t.add(attempt_id=A1, user_id=ALICE, state="ready")
    add_user(sessions, ALICE, "alice@example.com")
    with client(make_app(sessions, clock, ConsentService(sessions, t, audit, FakeSettingsPort(), KEYS, now=clock))) as c:
        sign_in(c)
        r = c.get(f"/api/v1/consent/notice?attempt_id={A1}")
    assert (r.status_code, r.json()["code"]) == (409, "ATT-INVALID-STATE")


def body_for(web, attempt=A1, decision="granted"):
    n = web.get(f"/api/v1/consent/notice?attempt_id={attempt}").json()
    return {"attempt_id": attempt, "notice_version": n["notice_version"], "notice_text_sha256": n["notice_text_sha256"], "decision": decision}


def test_grant_over_http_returns_201_and_the_record_and_it_shows_in_the_list(web, sessions, targets, audit):
    csrf = sign_in(web)
    r = web.post("/api/v1/consent", json=body_for(web), headers=csrf)
    rec = r.json()
    assert r.status_code == 201 and r.headers["cache-control"] == "private, no-store"
    assert set(rec) == {"consent_id", "attempt_id", "notice_version", "decision", "recorded_at"}
    assert rec["decision"] == "granted" and rec["attempt_id"] == A1 and rec["recorded_at"] == "2026-10-18T10:00:07Z"
    assert targets.find(A1).state == "ready" and audit.records[0].action == "consent.granted"
    listed = web.get("/api/v1/me/consents")
    assert listed.status_code == 200 and listed.json() == {"items": [rec], "has_more": False}
    [row] = rows(sessions)
    assert row.user_id == ALICE and row.ip_hash and row.ua_hash, "the address and browser of the request were hashed in"


def test_decline_over_http_ends_the_attempt(web, targets):
    csrf = sign_in(web)
    r = web.post("/api/v1/consent", json=body_for(web, decision="declined"), headers=csrf)
    assert r.status_code == 201 and r.json()["decision"] == "declined" and targets.find(A1).state == "cancelled"


def test_a_stale_text_over_http_is_409_att_consent_stale_and_writes_nothing(web, sessions):
    csrf = sign_in(web)
    body = body_for(web) | {"notice_text_sha256": "a" * 64}
    r = web.post("/api/v1/consent", json=body, headers=csrf)
    assert (r.status_code, r.json()["code"]) == (409, "ATT-CONSENT-STALE") and rows(sessions) == []


def test_the_opposite_decision_after_a_decision_is_409_and_the_same_one_is_201_again(web, sessions):
    csrf = sign_in(web)
    first = web.post("/api/v1/consent", json=body_for(web), headers=csrf)
    again = web.post("/api/v1/consent", json={"attempt_id": A1, "notice_version": first.json()["notice_version"], "notice_text_sha256": "e" * 64, "decision": "granted"},
                     headers=csrf)
    other = web.post("/api/v1/consent", json={"attempt_id": A1, "notice_version": first.json()["notice_version"], "notice_text_sha256": "e" * 64, "decision": "declined"},
                     headers=csrf)
    assert again.status_code == 201 and again.json() == first.json()
    assert (other.status_code, other.json()["code"]) == (409, "ATT-INVALID-STATE") and len(rows(sessions)) == 1


def test_someone_elses_attempt_cannot_be_decided(web, sessions, targets):
    csrf = sign_in(web)
    body = {"attempt_id": A3, "notice_version": NOTICE_VERSION, "notice_text_sha256": "0" * 64, "decision": "granted"}
    r = web.post("/api/v1/consent", json=body, headers=csrf)
    assert (r.status_code, r.json()["code"]) == (404, "ATT-NOT-FOUND") and rows(sessions) == [] and targets.find(A3).state == "consent"


@pytest.mark.parametrize("patch", [
    {"decision": "withdrawn"}, {"decision": "GRANTED"}, {"decision": True}, {"attempt_id": "nope"}, {"notice_version": "1"}, {"notice_text_sha256": "short"},
    {"extra": 1}, {"decision": None},
])
def test_a_body_that_does_not_fit_is_422_and_writes_nothing(web, sessions, patch):
    csrf = sign_in(web)
    r = web.post("/api/v1/consent", json=body_for(web) | patch, headers=csrf)
    assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION" and rows(sessions) == []


def test_a_missing_member_is_422(web):
    csrf = sign_in(web)
    body = body_for(web)
    del body["decision"]
    assert web.post("/api/v1/consent", json=body, headers=csrf).status_code == 422


def test_the_decision_needs_the_csrf_token_and_the_dashboard_origin_and_json(web, sessions):
    csrf = sign_in(web)
    body = body_for(web)
    assert web.post("/api/v1/consent", json=body).json()["code"] == "AUTH-CSRF-FAILED"
    assert web.post("/api/v1/consent", json=body, headers={"x-csrf-token": "x" * 40}).status_code == 403
    assert web.post("/api/v1/consent", json=body, headers=csrf | {"origin": "https://evil.example"}).json()["code"] == "AUTH-ORIGIN-FORBIDDEN"
    assert web.post("/api/v1/consent", content=b"decision=granted", headers=csrf | {"content-type": "text/plain"}).status_code == 415
    assert rows(sessions) == []


def test_the_list_has_a_limit_between_1_and_100(web):
    sign_in(web)
    assert web.get("/api/v1/me/consents?limit=100").status_code == 200
    for bad in ("0", "101", "abc", "-1"):
        r = web.get(f"/api/v1/me/consents?limit={bad}")
        assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION", bad


def test_the_list_never_shows_another_persons_records(web, sessions):
    csrf = sign_in(web)
    web.post("/api/v1/consent", json=body_for(web), headers=csrf)
    web.cookies.clear()
    sign_in(web, "bob@example.com")
    assert web.get("/api/v1/me/consents").json() == {"items": [], "has_more": False}


def test_decisions_are_limited_per_account(sessions, clock, service):
    add_user(sessions, ALICE, "alice@example.com")
    settings = FakeSettingsPort({"rate_consent_per_user_per_hour": 2})
    with client(make_app(sessions, clock, service, settings)) as c:
        csrf = sign_in(c)
        body = {"attempt_id": "a-ZZZZZZZZZZZZZZZZ", "notice_version": NOTICE_VERSION, "notice_text_sha256": "0" * 64, "decision": "granted"}
        codes = [c.post("/api/v1/consent", json=body, headers=csrf).status_code for _ in range(3)]
    assert codes == [404, 404, 429]


def test_the_service_missing_is_an_error_not_a_crash(sessions, clock):
    add_user(sessions, ALICE, "alice@example.com")
    app = make_app(sessions, clock, None)
    with client(app) as c:
        sign_in(c)
        r = c.get("/api/v1/me/consents")
    assert r.status_code == 500 and r.json()["code"] == "REQ-INTERNAL"


def test_a_declined_or_granted_record_never_holds_an_email_name_or_raw_address(web, sessions, audit):
    csrf = sign_in(web)
    web.post("/api/v1/consent", json=body_for(web), headers=csrf)
    [row] = rows(sessions)
    dump = " ".join(str(getattr(row, c.name)) for c in ConsentRecord.__table__.columns if c.name != "notice_text_snapshot")
    for secret in ("alice@example.com", "testclient", "127.0.0.1"):
        assert secret not in dump and secret not in str(audit.records[0].details)
    assert sessions().scalar(select(func.count()).select_from(ConsentRecord)) == 1
