"""Against a real Postgres 18: the migrations from empty and back, row-level security for the app role, and the session's
scope over pooled connections (ADR 0014, guard 2). Skipped unless both addresses are set:

  VULNMART_TEST_POSTGRES_DSN  the owner role (it creates and drops a throw-away database per run)
  VULNMART_TEST_APP_DSN       the app role of infra/compose/postgres/initdb/10-app-role.sql (no owner, no BYPASSRLS)

Locally: docker run -d --name vm-pg-test -p 127.0.0.1:55432:5432 -e POSTGRES_USER=vulnmart -e POSTGRES_DB=vulnmart
-e POSTGRES_PASSWORD=pw -e VULNMART_APP_DB_PASSWORD=apppw -v <repo>/infra/compose/postgres/initdb:/docker-entrypoint-initdb.d:ro
postgres:18.6-trixie, then VULNMART_TEST_POSTGRES_DSN=postgresql://vulnmart:pw@127.0.0.1:55432/vulnmart and
VULNMART_TEST_APP_DSN=postgresql://vulnmart_app:apppw@127.0.0.1:55432/vulnmart.
"""
from __future__ import annotations

import os
import uuid

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

import vulnmart.accounts.models  # noqa: F401
import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.orgs.models  # noqa: F401
from support import ROOT
from vulnmart.kernel.db import Base, make_engine, make_sessions
from vulnmart.kernel.scope import ContextScopePort, scope_or_none
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.orgs.models import OrgMember
from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.scope import Scope

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN (see the module docstring)")

ORG_A, ORG_B = uuid.UUID(int=0xA), uuid.UUID(int=0xB)
scope = ContextScopePort()


def with_db(dsn: str, name: str) -> str:
    return make_url(sqlalchemy_url(dsn)).set(database=name).render_as_string(hide_password=False).replace("postgresql+psycopg://", "postgresql://")


@pytest.fixture(scope="module")
def db():
    """A throw-away database, migrated to head by the owner, with two companies seeded (the owner bypasses RLS)."""
    name = f"vm_p06_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    owner_dsn, app_dsn = with_db(OWNER, name), with_db(APP, name)
    os.environ["VULNMART_MIGRATE_DSN"] = owner_dsn
    try:
        config = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
        command.upgrade(config, "head")
        owner = create_engine(sqlalchemy_url(owner_dsn))
        with owner.begin() as c:
            for org in (ORG_A, ORG_B):
                c.execute(text("INSERT INTO organizations (id, name, email_domain, owner_user_id, status) VALUES (:id, :n, :d, :u, 'active')"),
                          {"id": org, "n": f"Org {org.int}", "d": f"o{org.int}.example", "u": f"u-{org.int}"})
            c.execute(text("INSERT INTO org_members (org_id, user_id, role) VALUES (:a, 'u-a1', 'owner'), (:a, 'u-a2', 'member'), (:b, 'u-b1', 'owner')"),
                      {"a": ORG_A, "b": ORG_B})
        yield {"name": name, "owner_dsn": owner_dsn, "app_dsn": app_dsn, "config": config, "owner": owner}
        owner.dispose()
    finally:
        os.environ.pop("VULNMART_MIGRATE_DSN", None)
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def test_the_schema_matches_the_models(db):
    with db["owner"].connect() as c:
        diffs = compare_metadata(MigrationContext.configure(c), Base.metadata)
    assert diffs == [], diffs


def test_the_app_role_owns_nothing_and_cannot_bypass_row_level_security(db):
    app = create_engine(sqlalchemy_url(db["app_dsn"]))
    with app.connect() as c:
        row = c.execute(text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).one()
        owners = c.execute(text("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'")).scalars().all()
        forced = c.execute(text("SELECT relname FROM pg_class WHERE relforcerowsecurity ORDER BY relname")).scalars().all()
    app.dispose()
    assert tuple(row) == (False, False)
    assert "vulnmart_app" not in owners
    assert forced == ["org_members", "organizations"]


def test_row_level_security_shows_only_the_organisation_of_the_transaction(db):
    app = create_engine(sqlalchemy_url(db["app_dsn"]))
    with app.begin() as c:
        assert c.execute(text("SELECT count(*) FROM org_members")).scalar_one() == 0, "no setting: no row"
    with app.begin() as c:
        c.execute(text("SELECT set_config('vulnmart.org_id', :o, true)"), {"o": str(ORG_A)})
        assert sorted(c.execute(text("SELECT user_id FROM org_members")).scalars()) == ["u-a1", "u-a2"]
        assert c.execute(text("SELECT count(*) FROM organizations")).scalar_one() == 1
    with app.begin() as c:
        c.execute(text("SELECT set_config('vulnmart.org_id', :o, true)"), {"o": str(ORG_A)})
        with pytest.raises(DBAPIError, match="row-level security"):
            c.execute(text("INSERT INTO org_members (org_id, user_id, role) VALUES (:b, 'u-evil', 'member')"), {"b": ORG_B})
    with app.begin() as c:
        c.execute(text("SELECT set_config('vulnmart.org_id', :o, true)"), {"o": str(ORG_A)})
        changed = c.execute(text("UPDATE org_members SET status = 'removed' WHERE org_id = :b"), {"b": ORG_B}).rowcount
        assert changed == 0, "another company's rows cannot be updated"
        c.rollback()
    app.dispose()


def test_the_session_sets_the_scope_per_transaction_and_a_pooled_connection_keeps_nothing(db):
    engine = make_engine(db["app_dsn"], pool_size=1, max_overflow=0)
    sessions = make_sessions(engine, scope_or_none)
    with sessions() as s, pytest.raises(ScopeMissing):
        s.execute(select(OrgMember)).all()
    with scope.acting_as(Scope("u-r", org_id=str(ORG_B))), sessions() as s:
        assert [m.user_id for m in s.execute(select(OrgMember)).scalars()] == ["u-b1"]
        assert s.execute(text("SELECT current_setting('vulnmart.org_id', true)")).scalar_one() == str(ORG_B)
    # the same (only) pooled connection, no scope: the setting ended with the transaction
    with sessions() as s:
        assert s.execute(text("SELECT coalesce(current_setting('vulnmart.org_id', true), '')")).scalar_one() == ""
        assert s.execute(text("SELECT count(*) FROM org_members")).scalar_one() == 0, "raw SQL without scope sees nothing (RLS)"
    # a plain-table read with a scope: the session does not filter it, row-level security does
    from sqlalchemy import func

    with scope.acting_as(Scope("u-r", org_id=str(ORG_A))), sessions() as s:
        assert s.execute(select(func.count()).select_from(OrgMember.__table__)).scalar_one() == 2
    engine.dispose()


def test_the_settings_and_quota_tables_need_no_scope_and_hold_their_rules(db):
    app = create_engine(sqlalchemy_url(db["app_dsn"]))
    with app.begin() as c:
        c.execute(text("INSERT INTO settings (key, value) VALUES ('session_idle_minutes', '20'::jsonb)"))
        c.execute(text("INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'global', NULL, 2)"))
    with app.begin() as c, pytest.raises(DBAPIError):
        c.execute(text("INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'global', NULL, 3)"))
    with app.begin() as c, pytest.raises(DBAPIError):
        c.execute(text("INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'user', NULL, 3)"))
    from vulnmart.kernel.settings import DbSettingsPort

    assert DbSettingsPort(make_sessions(app, scope_or_none)).get("session_idle_minutes") == 20
    app.dispose()


def test_downgrade_to_empty_and_upgrade_again(db):
    command.downgrade(db["config"], "base")
    with db["owner"].connect() as c:
        left = c.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'")).scalars().all()
    assert left == []
    command.upgrade(db["config"], "head")
    with db["owner"].connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0005"


def test_the_migration_stops_when_the_app_role_does_not_exist(monkeypatch):
    name = f"vm_p06_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    try:
        monkeypatch.setenv("VULNMART_MIGRATE_DSN", with_db(OWNER, name))
        monkeypatch.setenv("VULNMART_APP_ROLE", "no_such_role")
        with pytest.raises(DBAPIError, match="no_such_role does not exist"):
            command.upgrade(Config(str(ROOT / "apps" / "api" / "alembic.ini")), "head")
        check = create_engine(sqlalchemy_url(with_db(OWNER, name)))
        with check.connect() as c:
            stamped = c.execute(text("SELECT count(*) FROM pg_tables WHERE tablename = 'alembic_version'")).scalar_one()
            version = c.execute(text("SELECT count(*) FROM alembic_version")).scalar_one() if stamped else 0
        check.dispose()
        assert version == 0, "nothing is stamped: the whole migration rolled back"
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
