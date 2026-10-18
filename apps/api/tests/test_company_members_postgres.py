"""Story P-19 against a real Postgres 18 as the application role: the new tables and their row-level security and privileges, the rule that every
organisation-scoped table has its policy, and the races (the first signup of a work domain, two decisions on one join request, two acceptances of the terms).

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import threading
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from test_companies_postgres import (  # noqa: F401 - the fixtures and helpers of story P-18
    ADMIN_SCOPE, APP, OWNER, add_admin, app_engine, clean, companies, database, owner, sessions, settings_query, signup,
)
from vulnmart.kernel.db import ORG_SCOPED
from vulnmart.orgs.service import InvalidTransition

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")


def uid(owner, email):
    with owner.connect() as c:
        return c.execute(text("SELECT id FROM users WHERE email_ci = :e"), {"e": email}).scalar_one()


def verify_all(owner):
    with owner.begin() as c:
        c.execute(text("UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL"))


# ---- row-level security and privileges --------------------------------------------------------------------------------------------------

def test_every_organisation_scoped_table_has_row_level_security_forced_and_its_policy(owner):
    with owner.connect() as c:
        flags = {r[0]: (r[1], r[2]) for r in c.execute(text("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY(:t)"),
                                                          {"t": sorted(ORG_SCOPED)})}
        policies = {(r[0], r[1]) for r in c.execute(text("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'"))}
    assert set(flags) == set(ORG_SCOPED)
    for table in ORG_SCOPED:
        assert flags[table] == (True, True), f"{table}: row-level security must be enabled and forced"
        assert (table, "org_scope") in policies, f"{table}: the org_scope policy is missing"


def test_one_company_claims_a_domain_at_the_database_level(owner):
    with owner.begin() as c:
        c.execute(text("INSERT INTO organizations (id, name, email_domain, domain_claim, status, owner_user_id) VALUES (gen_random_uuid(), 'A', 'd.example', 'd.example', 'pending', 'u-A')"))
        c.execute(text("INSERT INTO organizations (id, name, email_domain, domain_claim, status, owner_user_id) VALUES (gen_random_uuid(), 'B', 'x.example', NULL, 'pending', 'u-B')"))
        c.execute(text("INSERT INTO organizations (id, name, email_domain, domain_claim, status, owner_user_id) VALUES (gen_random_uuid(), 'C', 'x.example', NULL, 'pending', 'u-C')"))
    with pytest.raises(DBAPIError):
        with owner.begin() as c:
            c.execute(text("INSERT INTO organizations (id, name, email_domain, domain_claim, status, owner_user_id) VALUES (gen_random_uuid(), 'D', 'd.example', 'd.example', 'pending', 'u-D')"))


def test_join_requests_follow_the_company_and_their_requester_reads_their_own(app_engine, owner):
    a, b = uuid.uuid4(), uuid.uuid4()
    with owner.begin() as c:
        for oid, name in ((a, "A"), (b, "B")):
            c.execute(text("INSERT INTO organizations (id, name, email_domain, status, owner_user_id) VALUES (:i, :n, 'd.example', 'active', 'u-OWNEROWNEROWNER2')"),
                      {"i": oid, "n": name})
        for oid, user in ((a, "u-AAAAAAAAAAAAAAAA"), (b, "u-BBBBBBBBBBBBBBBB")):
            c.execute(text("INSERT INTO join_requests (id, org_id, user_id) VALUES (gen_random_uuid(), :o, :u)"), {"o": oid, "u": user})
    assert settings_query(app_engine, "SELECT count(*) FROM join_requests")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM join_requests", vulnmart__org_id=str(a))[0][0] == 1
    assert [r[0] for r in settings_query(app_engine, "SELECT user_id FROM join_requests", vulnmart__user_id="u-BBBBBBBBBBBBBBBB")] == ["u-BBBBBBBBBBBBBBBB"]
    assert settings_query(app_engine, "SELECT count(*) FROM join_requests", vulnmart__admin="on")[0][0] == 0, "an admin does not read join requests"
    with pytest.raises(DBAPIError):  # the requester reads their own request; they cannot write it without the company in scope
        settings_query(app_engine, "INSERT INTO join_requests (id, org_id, user_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'u-BBBBBBBBBBBBBBBB')",
                       vulnmart__user_id="u-BBBBBBBBBBBBBBBB")


@pytest.mark.parametrize("statement", [
    "UPDATE dpa_acceptances SET terms_version = 'x'", "DELETE FROM dpa_acceptances", "TRUNCATE dpa_acceptances",
    "DELETE FROM join_requests", "TRUNCATE join_requests",
])
def test_the_application_role_cannot_change_or_delete_what_it_must_not(app_engine, statement):
    with pytest.raises(DBAPIError, match="permission denied"):
        with app_engine.begin() as c:
            c.execute(text(statement))


def test_dpa_acceptances_are_scoped_to_their_company(app_engine, owner):
    a, b = uuid.uuid4(), uuid.uuid4()
    with owner.begin() as c:
        for oid in (a, b):
            c.execute(text("INSERT INTO organizations (id, name, email_domain, status, owner_user_id) VALUES (:i, 'X', 'd.example', 'active', 'u-OWNEROWNEROWNER2')"), {"i": oid})
            c.execute(text("INSERT INTO dpa_acceptances (id, org_id, user_id, terms_version, terms_sha256, accepted_at) VALUES (gen_random_uuid(), :o, 'u-X', 'v1', :h, now())"),
                      {"o": oid, "h": "a" * 64})
    assert settings_query(app_engine, "SELECT count(*) FROM dpa_acceptances")[0][0] == 0
    assert settings_query(app_engine, "SELECT count(*) FROM dpa_acceptances", vulnmart__org_id=str(a))[0][0] == 1
    with pytest.raises(DBAPIError):  # one acceptance per company and version
        with owner.begin() as c:
            c.execute(text("INSERT INTO dpa_acceptances (id, org_id, user_id, terms_version, terms_sha256, accepted_at) VALUES (gen_random_uuid(), :o, 'u-Y', 'v1', :h, now())"),
                      {"o": a, "h": "b" * 64})


def test_the_invite_cap_cannot_be_negative(owner):
    oid = uuid.uuid4()
    with owner.begin() as c:
        c.execute(text("INSERT INTO organizations (id, name, email_domain, status, owner_user_id) VALUES (:i, 'X', 'd.example', 'active', 'u-O')"), {"i": oid})
    with pytest.raises(DBAPIError):
        with owner.begin() as c:
            c.execute(text("UPDATE organizations SET invite_cap = -1 WHERE id = :i"), {"i": oid})


# ---- the service as the application role -------------------------------------------------------------------------------------------------

def test_a_whole_company_story_works_through_row_level_security(companies, owner):
    add_admin(owner)
    signup(companies, "ana@acme.example", "Acme", "Ana Owner")
    signup(companies, "bo@acme.example", "ignored", "Bo Colleague")
    verify_all(owner)
    ana, bo = uid(owner, "ana@acme.example"), uid(owner, "bo@acme.example")
    org_id = companies.standing(ana).org_id
    assert companies.claimed_by("acme.example") == org_id and companies.membership_of(bo) is None
    companies.approve(ADMIN_SCOPE, org_id)
    [req] = companies.join_requests(ana)
    companies.approve_join(ana, req.request_id)
    assert companies.membership_of(bo) == (org_id, "member")
    version, digest = (lambda t: (t.version, t.sha256))(companies.terms_for(ana))
    with pytest.raises(Exception) as e:
        companies.invite_company_of(bo)
    assert type(e.value).__name__ == "TermsNotAccepted"
    companies.accept_terms(ana, version, digest)
    assert companies.invite_company_of(bo) == org_id
    companies.set_invite_cap(ADMIN_SCOPE, org_id, 3)
    assert (lambda d: (d.allowed, d.remaining))(companies.check_invite_cap(org_id, 2)) == (True, 1)
    companies.remove_member(ana, bo)
    assert companies.membership_of(bo) is None
    companies.delete_company(ADMIN_SCOPE, org_id, "test cleanup")
    assert companies.claimed_by("acme.example") is None and companies.standing(ana).state == "deleted"


def test_eight_first_signups_of_one_new_work_domain_make_one_company_and_seven_requests(companies, owner):
    barrier, errors = threading.Barrier(8), []

    def go(i: int):
        barrier.wait()
        try:
            signup(companies, f"p{i}@fresh.example", f"Company {i}", f"Person {i}")
        except Exception as exc:  # noqa: BLE001 - counted below
            errors.append(exc)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM users")).scalar_one() == 8
        assert c.execute(text("SELECT count(*) FROM organizations")).scalar_one() == 1, "one company claimed the domain"
        assert c.execute(text("SELECT count(*) FROM organizations WHERE domain_claim = 'fresh.example'")).scalar_one() == 1
        assert c.execute(text("SELECT count(*) FROM join_requests")).scalar_one() == 7, "everyone else asked to join it"
        assert c.execute(text("SELECT count(*) FROM org_members")).scalar_one() == 1


def test_eight_owners_decisions_on_one_request_add_one_member_and_send_one_mail(companies, owner):
    add_admin(owner)
    signup(companies, "ana@acme.example", "Acme", "Ana")
    signup(companies, "bo@acme.example", "x", "Bo")
    verify_all(owner)
    ana = uid(owner, "ana@acme.example")
    companies.approve(ADMIN_SCOPE, companies.standing(ana).org_id)
    [req] = companies.join_requests(ana)
    barrier, results = threading.Barrier(8), []

    def decide(i: int):
        barrier.wait()
        try:
            (companies.approve_join if i % 2 else companies.reject_join)(ana, req.request_id)
            results.append("decided")
        except InvalidTransition:
            results.append("late")

    threads = [threading.Thread(target=decide, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results.count("decided") == 1 and results.count("late") == 7
    with owner.connect() as c:
        decided = c.execute(text("SELECT status FROM join_requests")).scalar_one()
        members = c.execute(text("SELECT count(*) FROM org_members WHERE role = 'member'")).scalar_one()
        mails = c.execute(text("SELECT count(*) FROM email_outbox WHERE template = 'org.approval_outcome' AND to_user_id = :u"), {"u": uid(owner, "bo@acme.example")}).scalar_one()
    assert decided in ("approved", "rejected") and members == (1 if decided == "approved" else 0) and mails == 1


def test_eight_acceptances_of_the_terms_make_one_record_and_one_audit_entry(companies, owner):
    add_admin(owner)
    signup(companies, "ana@acme.example", "Acme", "Ana")
    verify_all(owner)
    ana = uid(owner, "ana@acme.example")
    companies.approve(ADMIN_SCOPE, companies.standing(ana).org_id)
    t = companies.terms_for(ana)
    barrier, errors = threading.Barrier(8), []

    def accept():
        barrier.wait()
        try:
            companies.accept_terms(ana, t.version, t.sha256)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=accept) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM dpa_acceptances")).scalar_one() == 1
    assert len([r for r in companies._audit.records if r.action == "org.terms_accepted"]) == 1, "only the request that wrote the record wrote an audit entry"
