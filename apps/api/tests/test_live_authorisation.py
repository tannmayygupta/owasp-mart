"""Story P-23 (FR-LIV-05): every stream is authorised per user and company, on the server, from the session and the standing of the company. Real session, company and
account services on SQLite; the streams are the in-memory store. Learners, candidates, recruiters of two companies, a recruiter of a company that is not active, admins
with and without a second factor: each is asked to read the streams of everyone else, and gets exactly its own."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

import vulnmart.accounts.models  # noqa: F401
import vulnmart.assessments.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
from test_companies import ADMIN, ADMIN_SCOPE, GOOD, ORIGIN, T0, add_admin, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import ResolvedSession, SessionService, UserView
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.live.api import session_still_allowed
from vulnmart.live.authorise import StreamAuthoriser
from vulnmart.live.hub import HubConfig
from vulnmart.live.store import MemoryStreamStore
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role

COOKIE = "__Host-vm_session"


@pytest.fixture
def sessions_service(sessions, clock, companies):
    return SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=clock, org_resolver=companies.membership_of)


@pytest.fixture
def authoriser(companies):
    return StreamAuthoriser(companies.active_company_of)


def new_company(companies, sessions, email, company, *, approve=True):
    """A company with an owner (recruiter). Returns (owner id, company id)."""
    signup(companies, email=email, company=company, name=f"Owner of {company}")
    verify(sessions, email)
    owner = user_id(sessions, email)
    org = str(org_row(sessions, email).id)
    if approve:
        companies.approve(ADMIN_SCOPE, org)
    return owner, org


def participant(sessions, uid, email, *, roles=("learner",)):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="participant", email=email, email_ci=email, password_hash="x", display_name="P", status="active", email_verified_at=T0))
        s.flush()
        for role in roles:
            s.add(UserRole(user_id=uid, role=role, account_type="participant"))


def open_session(service, uid, *, mfa=False) -> tuple[str, ResolvedSession]:
    result = service.open_session(uid, ip_trunc=None, ua_class=None, mfa=mfa)
    return result.token, result.session


LEARNER, CANDIDATE, OTHER_LEARNER = "u-LEARNERLEARNER22", "u-CANDIDATECANDID2", "u-OTHERLEARNER2222"


@pytest.fixture
def world(sessions, companies, sessions_service):
    """Two active companies (A with an owner and a colleague, B with an owner), a company that is only pending, a learner, a candidate and two admins."""
    add_admin(sessions)
    with sessions.begin() as s:
        s.add(User(id="u-ADMINNOMFAADMIN22", account_type="admin", email="a2@example.org", email_ci="a2@example.org", password_hash="x", display_name="A2", status="active",
                   email_verified_at=T0))
    owner_a, org_a = new_company(companies, sessions, "ana@acme.example", "Acme")
    owner_b, org_b = new_company(companies, sessions, "bo@globex.example", "Globex")
    owner_p, org_p = new_company(companies, sessions, "pat@pending.example", "Pending", approve=False)
    signup(companies, email="cy@acme.example", company="x", name="Cy Colleague")
    verify(sessions, "cy@acme.example")
    colleague = user_id(sessions, "cy@acme.example")
    companies.approve_join(owner_a, {r.user_id: r.request_id for r in companies.join_requests(owner_a)}[colleague])
    participant(sessions, LEARNER, "learner@example.org")
    participant(sessions, OTHER_LEARNER, "other@example.org")
    participant(sessions, CANDIDATE, "cand@example.org", roles=("learner", "candidate"))
    return {"owner_a": owner_a, "org_a": org_a, "owner_b": owner_b, "org_b": org_b, "owner_p": owner_p, "org_p": org_p, "colleague": colleague}


# ---- the streams of each kind of person --------------------------------------------------------------------------------------------------

def streams(authoriser, service, uid, **kw):
    return authoriser.streams(open_session(service, uid, **kw)[1])


def test_a_learner_and_a_candidate_get_their_own_user_stream_and_nothing_else(world, authoriser, sessions_service):
    assert streams(authoriser, sessions_service, LEARNER) == [f"live:user:{LEARNER}"]
    assert streams(authoriser, sessions_service, CANDIDATE) == [f"live:user:{CANDIDATE}"]


def test_a_recruiter_of_an_active_company_gets_the_company_stream_and_so_does_a_colleague(world, authoriser, sessions_service):
    assert streams(authoriser, sessions_service, world["owner_a"]) == [f"live:user:{world['owner_a']}", f"live:org:{world['org_a']}"]
    assert streams(authoriser, sessions_service, world["colleague"]) == [f"live:user:{world['colleague']}", f"live:org:{world['org_a']}"]
    assert streams(authoriser, sessions_service, world["owner_b"]) == [f"live:user:{world['owner_b']}", f"live:org:{world['org_b']}"]


def test_a_recruiter_of_a_company_that_is_not_active_gets_no_company_stream(world, companies, authoriser, sessions_service):
    """The session carries the company of an active membership whatever the company's state; the stream asks for the company's standing."""
    assert open_session(sessions_service, world["owner_p"])[1].org_id == world["org_p"], "the session itself does name the pending company"
    assert streams(authoriser, sessions_service, world["owner_p"]) == [f"live:user:{world['owner_p']}"]
    companies.suspend(ADMIN_SCOPE, world["org_b"], "a reason")
    assert streams(authoriser, sessions_service, world["owner_b"]) == [f"live:user:{world['owner_b']}"], "a suspended company"
    companies.reinstate(ADMIN_SCOPE, world["org_b"], "back again")
    assert f"live:org:{world['org_b']}" in streams(authoriser, sessions_service, world["owner_b"])


def test_a_recruiter_removed_from_the_company_has_no_company_stream(world, companies, authoriser, sessions_service):
    companies.remove_member(world["owner_a"], world["colleague"])
    assert streams(authoriser, sessions_service, world["colleague"]) == [f"live:user:{world['colleague']}"]
    assert streams(authoriser, sessions_service, world["owner_a"])[1] == f"live:org:{world['org_a']}", "the others keep theirs"


def test_an_admin_gets_the_admin_stream_only_with_a_second_factor_in_the_session(world, authoriser, sessions_service):
    assert streams(authoriser, sessions_service, ADMIN, mfa=True) == [f"live:user:{ADMIN}", "live:admin"]
    assert streams(authoriser, sessions_service, ADMIN, mfa=False) == [f"live:user:{ADMIN}"]
    assert streams(authoriser, sessions_service, "u-ADMINNOMFAADMIN22", mfa=False) == ["live:user:u-ADMINNOMFAADMIN22"]


def test_nobody_but_an_admin_gets_the_admin_stream_and_no_learner_gets_a_company(world, authoriser, sessions_service):
    for uid in (LEARNER, CANDIDATE, OTHER_LEARNER, world["owner_a"], world["owner_b"], world["colleague"]):
        got = streams(authoriser, sessions_service, uid)
        assert "live:admin" not in got, uid
    for uid in (LEARNER, CANDIDATE, OTHER_LEARNER):
        assert not any(s.startswith("live:org:") for s in streams(authoriser, sessions_service, uid)), uid


def test_two_people_never_share_a_user_stream_and_two_companies_never_share_a_company_stream(world, authoriser, sessions_service):
    people = [LEARNER, CANDIDATE, OTHER_LEARNER, world["owner_a"], world["owner_b"], ADMIN]
    own = [streams(authoriser, sessions_service, uid, mfa=True)[0] for uid in people]
    assert len(set(own)) == len(own)
    assert set(streams(authoriser, sessions_service, world["owner_a"])) & set(streams(authoriser, sessions_service, world["owner_b"])) == set()


def test_without_a_way_to_ask_for_the_company_a_recruiter_gets_no_company_stream(world, sessions_service):
    assert streams(StreamAuthoriser(), sessions_service, world["owner_a"]) == [f"live:user:{world['owner_a']}"]


def test_a_failing_company_lookup_grants_nothing(world, sessions_service):
    def broken(uid):
        raise ConnectionError("database down")

    assert streams(StreamAuthoriser(broken), sessions_service, world["owner_a"]) == [f"live:user:{world['owner_a']}"]


def test_a_company_that_is_not_the_sessions_company_grants_nothing(world, sessions_service):
    """The standing says another company than the session names (a membership that moved): no company stream."""
    assert streams(StreamAuthoriser(lambda uid: world["org_b"]), sessions_service, world["owner_a"]) == [f"live:user:{world['owner_a']}"]


# ---- while the stream is open --------------------------------------------------------------------------------------------------------------

def allowed(authoriser, service, token, keys) -> bool:
    return asyncio.run(session_still_allowed(service, authoriser, token, keys))


def test_an_open_stream_goes_on_while_nothing_changes(world, authoriser, sessions_service):
    token, session = open_session(sessions_service, world["owner_a"])
    assert allowed(authoriser, sessions_service, token, authoriser.streams(session))


def test_an_open_stream_ends_when_the_session_is_logged_out_or_revoked(world, authoriser, sessions_service):
    token, session = open_session(sessions_service, LEARNER)
    keys = authoriser.streams(session)
    assert sessions_service.logout(token)
    assert not allowed(authoriser, sessions_service, token, keys)
    token2, session2 = open_session(sessions_service, LEARNER)
    keys2 = authoriser.streams(session2)
    sessions_service.revoke_all(LEARNER)
    assert not allowed(authoriser, sessions_service, token2, keys2)


def test_an_open_stream_ends_when_the_session_times_out(world, authoriser, sessions_service, clock):
    from datetime import timedelta

    token, session = open_session(sessions_service, LEARNER)
    clock.now += timedelta(hours=13)
    assert not allowed(authoriser, sessions_service, token, authoriser.streams(session))


def test_an_open_company_stream_ends_when_the_company_is_suspended(world, companies, authoriser, sessions_service):
    token, session = open_session(sessions_service, world["owner_a"])
    keys = authoriser.streams(session)
    assert len(keys) == 2
    companies.suspend(ADMIN_SCOPE, world["org_a"], "a reason")
    assert not allowed(authoriser, sessions_service, token, keys)


def test_an_open_company_stream_ends_when_the_recruiter_is_removed_or_suspended(world, companies, authoriser, sessions_service):
    token, session = open_session(sessions_service, world["colleague"])
    keys = authoriser.streams(session)
    companies.remove_member(world["owner_a"], world["colleague"])
    assert not allowed(authoriser, sessions_service, token, keys)
    token2, session2 = open_session(sessions_service, world["owner_b"])
    keys2 = authoriser.streams(session2)
    assert allowed(authoriser, sessions_service, token2, keys2)
    companies.delete_company(ADMIN_SCOPE, world["org_b"], "closed")
    assert not allowed(authoriser, sessions_service, token2, keys2)


def test_an_open_admin_stream_ends_when_the_account_is_disabled(world, sessions, authoriser, sessions_service):
    token, session = open_session(sessions_service, ADMIN, mfa=True)
    keys = authoriser.streams(session)
    assert keys[1] == "live:admin" and allowed(authoriser, sessions_service, token, keys)
    with sessions.begin() as s:
        s.get(User, ADMIN).status = "disabled"
    assert not allowed(authoriser, sessions_service, token, keys)


# ---- over HTTP, with real sessions -----------------------------------------------------------------------------------------------------------

def event(owner_tag: str) -> str:
    return json.dumps({"schema_version": 1, "type": "attempt.milestone_reached", "occurred_at": "2026-10-18T10:00:00Z",
                       "data": {"attempt_id": "a-AAAAAAAAAAAAAAAA", "mode": "learner", "challenge_key": "C01", "milestone": "M1", "who": owner_tag}}, separators=(",", ":"))


@pytest.fixture
def web(sessions, companies, clock, sessions_service, authoriser):
    store = MemoryStreamStore()
    settings = FakeSettingsPort()
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=PasswordPolicy(),
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock), sessions=sessions_service, self_service=SelfService(sessions, sessions_service),
                     live_store=store, live_authoriser=authoriser, live_config=HubConfig(max_age_s=0.5, heartbeat_s=0.2, recheck_s=0.3, slow_s=0.3))
    app.state.ports.settings = settings
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=False) as client:
        client.store = store
        yield client


def read_as(web, token, last=None):
    headers = {"cookie": f"{COOKIE}={token}", **({"last-event-id": last} if last else {})}
    r = web.get("/api/v1/live", headers=headers)
    assert r.status_code == 200, r.text
    got = []
    for block in r.text.split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data: "):
                got.append(json.loads(line[6:])["data"]["who"])
    return sorted(got)


def test_each_kind_of_person_reads_exactly_their_own_streams_over_http(world, web, sessions_service):
    store = web.store
    sentinel = store.append("live:user:sentinel", 1, event("sentinel"))  # every connection replays from here
    streams_by_tag = {
        "learner": f"live:user:{LEARNER}", "other-learner": f"live:user:{OTHER_LEARNER}", "candidate": f"live:user:{CANDIDATE}",
        "owner-a": f"live:user:{world['owner_a']}", "colleague": f"live:user:{world['colleague']}", "owner-b": f"live:user:{world['owner_b']}",
        "admin-user": f"live:user:{ADMIN}", "org-a": f"live:org:{world['org_a']}", "org-b": f"live:org:{world['org_b']}", "org-pending": f"live:org:{world['org_p']}",
        "admin": "live:admin", "owner-pending": f"live:user:{world['owner_p']}",
    }
    for n, (tag, stream) in enumerate(streams_by_tag.items(), start=2):
        store.append(stream, n, event(tag))
    expected = {
        LEARNER: ["learner"], OTHER_LEARNER: ["other-learner"], CANDIDATE: ["candidate"],
        world["owner_a"]: ["org-a", "owner-a"], world["colleague"]: ["colleague", "org-a"], world["owner_b"]: ["org-b", "owner-b"],
        world["owner_p"]: ["owner-pending"],  # its company is not active: no company stream, and nobody else's either
    }
    for uid, tags in expected.items():
        token, _ = open_session(sessions_service, uid)
        assert read_as(web, token, sentinel) == sorted(tags), uid
    token, _ = open_session(sessions_service, ADMIN, mfa=True)
    assert read_as(web, token, sentinel) == ["admin", "admin-user"]
    token, _ = open_session(sessions_service, ADMIN, mfa=False)
    assert read_as(web, token, sentinel) == ["admin-user"], "an admin session without a second factor is not an admin session"


def test_the_event_id_of_another_persons_stream_is_only_a_place_in_time_never_a_way_into_their_events(world, web, sessions_service):
    store = web.store
    theirs = store.append(f"live:user:{OTHER_LEARNER}", 1, event("other-learner"))
    mine = store.append(f"live:user:{LEARNER}", 1, event("learner"))
    store.append(f"live:org:{world['org_a']}", 1, event("org-a"))
    token, _ = open_session(sessions_service, LEARNER)
    assert read_as(web, token, theirs) == ["learner"]
    assert read_as(web, token, mine) == []


def test_a_session_that_is_not_the_callers_cannot_open_a_stream(world, web):
    for cookie in ("", f"{COOKIE}=" + "A" * 43, f"{COOKIE}=not-a-token"):
        r = web.get("/api/v1/live", headers={"cookie": cookie})
        assert (r.status_code, r.json()["code"]) == (401, "AUTH-SESSION-REQUIRED"), cookie


def test_a_stream_of_a_suspended_company_gives_its_recruiter_no_company_events_over_http(world, companies, web, sessions_service):
    store = web.store
    sentinel = store.append("live:user:sentinel", 1, event("sentinel"))
    store.append(f"live:org:{world['org_a']}", 1, event("org-a"))
    token, _ = open_session(sessions_service, world["owner_a"])
    assert read_as(web, token, sentinel) == ["org-a"]
    companies.suspend(ADMIN_SCOPE, world["org_a"], "a reason")
    token2, _ = open_session(sessions_service, world["owner_a"])
    r = web.get("/api/v1/live", headers={"cookie": f"{COOKIE}={token2}", "last-event-id": sentinel})
    assert r.status_code in (200, 401) and "org-a" not in r.text


# ---- looking at a stream is not activity -------------------------------------------------------------------------------------------------------

def test_resolving_without_touching_does_not_keep_an_idle_session_alive(world, sessions_service, clock):
    from datetime import timedelta

    token, _ = open_session(sessions_service, LEARNER)
    clock.now += timedelta(minutes=5)
    assert sessions_service.resolve(token, touch=False) is not None
    clock.now += timedelta(minutes=26)  # 31 minutes since the last activity (the idle limit is 30)
    assert sessions_service.resolve(token, touch=False) is None
    token2, _ = open_session(sessions_service, OTHER_LEARNER)
    clock.now += timedelta(minutes=5)
    assert sessions_service.resolve(token2) is not None  # a real call counts as activity ...
    clock.now += timedelta(minutes=26)
    assert sessions_service.resolve(token2) is not None  # ... so 26 minutes later it is still alive


def test_an_open_dashboard_does_not_keep_its_session_alive_over_http(world, web, sessions_service, clock):
    """The stream and its snapshot are what a page does by itself: a page left open by an idle person still times out (FR-ACC-04)."""
    from datetime import timedelta

    token, _ = open_session(sessions_service, LEARNER)
    cookie = {"cookie": f"{COOKIE}={token}"}
    clock.now += timedelta(minutes=25)
    assert web.get("/api/v1/live", headers=cookie).status_code == 200
    assert web.get("/api/v1/live/snapshot", headers=cookie).status_code == 200
    clock.now += timedelta(minutes=6)  # 31 minutes since the person last did anything
    assert web.get("/api/v1/live", headers=cookie).status_code == 401
    token2, _ = open_session(sessions_service, OTHER_LEARNER)
    cookie2 = {"cookie": f"{COOKIE}={token2}"}
    clock.now += timedelta(minutes=25)
    assert web.get("/api/v1/me", headers=cookie2).status_code == 200  # a real call
    clock.now += timedelta(minutes=6)
    assert web.get("/api/v1/live", headers=cookie2).status_code == 200, "the real call at minute 25 extended the session"
