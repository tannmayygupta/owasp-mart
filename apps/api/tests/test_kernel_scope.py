"""Organisation scope in the session (ADR 0014, guard 1): a query on an org-scoped table without an organisation in scope
is refused; with one, only that organisation's rows come back. Runs on SQLite in memory: guard 2 (row-level security in
Postgres) is tested in test_kernel_postgres.py."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401 - registers the tables
from vulnmart.kernel.db import ORG_SCOPED, Base, ScopedSession, make_sessions
from vulnmart.kernel.models import JobRun
from vulnmart.kernel.scope import ContextScopePort, scope_or_none
from vulnmart.orgs.models import Organization, OrgMember
from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.scope import Role, Scope

ORG_A, ORG_B = uuid.UUID(int=1), uuid.UUID(int=2)
scope = ContextScopePort()


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = make_sessions(engine, scope_or_none)
    # seed both companies as the platform itself (a plain session, not scoped)
    from sqlalchemy.orm import Session

    with Session(engine) as s:
        s.add_all([
            Organization(id=ORG_A, name="A Ltd", email_domain="a.example", owner_user_id="u-A"),
            Organization(id=ORG_B, name="B Ltd", email_domain="b.example", owner_user_id="u-B"),
            OrgMember(org_id=ORG_A, user_id="u-A", role="owner"), OrgMember(org_id=ORG_A, user_id="u-A2", role="member"),
            OrgMember(org_id=ORG_B, user_id="u-B", role="owner"),
        ])
        s.commit()
    yield factory
    engine.dispose()


def recruiter(org: uuid.UUID) -> Scope:
    return Scope(user_id="u-R", org_id=str(org), roles=frozenset({Role.RECRUITER}))


def test_the_org_tables_are_registered_as_scoped():
    assert ORG_SCOPED["org_members"] == "org_id" and ORG_SCOPED["organizations"] == "id"
    assert "job_runs" not in ORG_SCOPED and "settings" not in ORG_SCOPED


def test_a_query_without_an_organisation_in_scope_is_refused(sessions):
    with sessions() as s, pytest.raises(ScopeMissing) as err:
        s.execute(select(OrgMember)).all()
    assert err.value.code.value == "REQ-INTERNAL"
    with scope.acting_as(Scope("u-L", roles=frozenset({Role.LEARNER}))), sessions() as s, pytest.raises(ScopeMissing):
        s.execute(select(Organization)).all()  # a user without an organisation is refused too


def test_with_an_organisation_only_its_rows_come_back(sessions):
    with scope.acting_as(recruiter(ORG_A)), sessions() as s:
        members = s.execute(select(OrgMember)).scalars().all()
        orgs = s.execute(select(Organization)).scalars().all()
    assert {m.user_id for m in members} == {"u-A", "u-A2"}
    assert [o.id for o in orgs] == [ORG_A]


def test_an_explicit_filter_for_another_organisation_finds_nothing(sessions):
    with scope.acting_as(recruiter(ORG_A)), sessions() as s:
        assert s.execute(select(OrgMember).where(OrgMember.org_id == ORG_B)).all() == []
        assert s.get(OrgMember, (ORG_B, "u-B")) is None, "a primary-key lookup is filtered too"


def test_joins_and_aggregates_are_filtered(sessions):
    from sqlalchemy import func

    with scope.acting_as(recruiter(ORG_B)), sessions() as s:
        rows = s.execute(select(Organization.name, OrgMember.user_id).join(OrgMember, OrgMember.org_id == Organization.id)).all()
        count = s.execute(select(func.count()).select_from(OrgMember)).scalar_one()
    assert rows == [("B Ltd", "u-B")]
    assert count == 1


def test_updates_and_deletes_are_scoped_too(sessions):
    with sessions() as s, pytest.raises(ScopeMissing):
        s.execute(update(OrgMember).values(status="removed"))
    with sessions() as s, pytest.raises(ScopeMissing):
        s.execute(delete(OrgMember))
    with scope.acting_as(recruiter(ORG_A)), sessions() as s:
        s.execute(update(OrgMember).values(status="removed"))
        s.commit()
    with scope.acting_as(recruiter(ORG_B)), sessions() as s:
        assert s.execute(select(OrgMember.status)).scalars().all() == ["active"], "company B was not touched"


def test_a_malformed_organisation_id_in_scope_is_refused_not_matched(sessions):
    with scope.acting_as(Scope("u-R", org_id="not-a-uuid")), sessions() as s, pytest.raises(ScopeMissing):
        s.execute(select(OrgMember)).all()


def test_a_table_that_is_not_org_scoped_needs_no_scope(sessions):
    with sessions() as s:
        assert s.execute(select(JobRun)).all() == []


def test_the_session_reads_the_scope_of_its_own_context(sessions):
    s = sessions()
    assert isinstance(s, ScopedSession)
    with scope.acting_as(recruiter(ORG_A)):
        assert s.current_org() == str(ORG_A)
    assert s.current_org() is None
    s.close()


def test_context_scope_port():
    with pytest.raises(ScopeMissing):
        scope.current()
    with scope.acting_as(Scope("u-L")):
        assert scope.current().user_id == "u-L"
        with pytest.raises(ScopeMissing):
            scope.require_org()
        with scope.acting_as(Scope("u-R", org_id="o-1")):
            assert scope.require_org() == "o-1"
        assert scope.current().user_id == "u-L", "the inner block restores the outer scope"
    assert scope_or_none() is None


def test_a_subquery_or_a_plain_table_read_through_the_session_is_guarded(sessions):
    from sqlalchemy import func

    sub = select(OrgMember.user_id).scalar_subquery()
    with sessions() as s, pytest.raises(ScopeMissing):
        s.execute(select(JobRun.id).where(JobRun.job.in_(sub))).all()
    with sessions() as s, pytest.raises(ScopeMissing):
        s.execute(select(func.count()).select_from(OrgMember.__table__)).scalar_one()
    # with an organisation in scope, a plain-table read is not filtered by the session (documented limit of guard 1):
    # in Postgres the row-level security filters it, see test_kernel_postgres.py
    with scope.acting_as(recruiter(ORG_B)), sessions() as s:
        assert s.execute(select(func.count()).select_from(OrgMember.__table__)).scalar_one() == 3
    with scope.acting_as(recruiter(ORG_B)), sessions() as s:
        assert s.execute(select(func.count()).select_from(OrgMember)).scalar_one() == 1
        assert s.execute(select(JobRun.id).where(JobRun.job.in_(sub))).all() == []


def test_any_spelling_of_the_organisation_id_is_the_same_organisation(sessions):
    for spelling in (str(ORG_A).upper(), ORG_A.hex):
        s = sessions()
        with scope.acting_as(Scope("u-R", org_id=spelling)):
            assert s.current_org() == str(ORG_A), "the setting for Postgres uses the canonical spelling"
            assert {m.user_id for m in s.execute(select(OrgMember)).scalars()} == {"u-A", "u-A2"}
        s.close()


def test_the_organisation_cannot_change_inside_a_transaction(sessions):
    s = sessions()
    with scope.acting_as(recruiter(ORG_A)):
        s.execute(select(OrgMember)).all()  # the transaction begins with org A
        with scope.acting_as(recruiter(ORG_B)), pytest.raises(ScopeMissing, match="changed inside a transaction"):
            s.execute(select(OrgMember)).all()
    s.rollback()
    with scope.acting_as(recruiter(ORG_B)):
        assert {m.user_id for m in s.execute(select(OrgMember)).scalars()} == {"u-B"}, "a new transaction takes the new scope"
    s.close()
