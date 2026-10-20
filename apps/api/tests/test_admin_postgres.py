"""Story P-28 against a real Postgres 18 as the application role: the settings and quota tables the admin writes (rights, constraints), the real quota port the lab reads, and the
admin's operations on the real company service (a company approved, a user locked, a setting and a quota changed and read back). Skipped unless VULNMART_TEST_POSTGRES_DSN and
VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import vulnmart.lab.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from test_assessments_postgres import BASIC, company  # noqa: F401
from test_companies_postgres import APP, OWNER, app_engine, clean, companies, database, owner, sessions  # noqa: F401
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.status import AccountStatusService
from vulnmart.admin.ops import AdminOps, NotFound
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.kernel.settings import DbSettingsPort
from vulnmart.ports.fakes import FakeAuditPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.retention.records import SqlAttemptRecords

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
ADMIN = "u-ADMINADMINADMIN2"
ADMIN_SCOPE = Scope(user_id=ADMIN, roles=frozenset({Role.ADMIN}))
LEARNER = "u-LEARNERONE222222"
ORG = "6f1c8f0e-0a5e-4a1c-9d5a-3f2d6a8b9c01"


@pytest.fixture(autouse=True)
def clean_admin(owner):
    with owner.begin() as c:
        c.execute(text("DELETE FROM settings"))
        c.execute(text("DELETE FROM quotas"))
    yield


def scalar(engine, sql, **params):
    with engine.connect() as c:
        return c.execute(text(sql), params).scalar_one()


def make_ops(sessions, companies, owner):
    with owner.begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at) VALUES (:i, 'admin', 'admin@example.org', "
                       "'admin@example.org', 'x', 'Admin', 'active', now()) ON CONFLICT DO NOTHING"), {"i": ADMIN})
    settings = DbSettingsPort(sessions)
    audit = FakeAuditPort()
    roles = RoleService(sessions, audit)
    ops = AdminOps(sessions=sessions, roles=roles, companies=companies, status=AccountStatusService(sessions, roles, audit), accounts=AccountService(sessions, settings, public_origin="https://x.example"),
                   settings=settings, quotas=DbQuotaPort(sessions, settings), audit=audit, records=SqlAttemptRecords(sessions), deletion=None, end_sessions=lambda uid: None)
    return ops, settings, audit


def test_the_application_role_can_write_settings_and_quotas_but_not_break_their_rules(owner, app_engine):
    with app_engine.begin() as c:
        c.execute(text("INSERT INTO settings (key, value, updated_by) VALUES ('email_daily_cap', '100'::jsonb, 's-ABCDEFGHIJKLMNOP')"))
        c.execute(text("UPDATE settings SET value = '120'::jsonb WHERE key = 'email_daily_cap'"))
        c.execute(text("INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'global', NULL, 3)"))
    for sql in ("INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'global', NULL, 4)",  # one global row (nulls not distinct)
                "INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'user', NULL, 4)",  # a user quota needs an id
                "INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'global', 'x', 4)",
                "INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'team', 'x', 4)",
                "INSERT INTO quotas (id, scope, scope_id, max_instances) VALUES (gen_random_uuid(), 'org', 'x', -1)"):
        with pytest.raises(DBAPIError):
            with app_engine.begin() as c:
                c.execute(text(sql))
    assert scalar(app_engine, "SELECT count(*) FROM quotas") == 1


def test_a_setting_and_a_quota_set_by_the_admin_are_what_the_lab_reads_at_once(sessions, companies, owner):
    ops, settings, audit = make_ops(sessions, companies, owner)
    ops.set_setting(ADMIN_SCOPE, "candidate_retention_days", 90)
    ops.set_setting(ADMIN_SCOPE, "instance_company_cap", 8)
    assert settings.get("candidate_retention_days") == 90 and DbSettingsPort(sessions).get("candidate_retention_days") == 90
    assert scalar(owner, "SELECT value::text FROM settings WHERE key = 'candidate_retention_days'") == "90"
    ops.set_quota(ADMIN_SCOPE, "org", ORG, 6)
    ops.set_quota(ADMIN_SCOPE, "user", LEARNER, 2)
    quota = DbQuotaPort(sessions, settings)
    assert quota.max_instances(LEARNER, ORG) == 2 and quota.max_instances("u-OTHERLEARNER2222", ORG) == 6 and quota.max_instances("u-OTHERLEARNER2222") == 1
    limits = quota.limits(LEARNER, ORG)
    assert (limits.user, limits.company, limits.total) == (2, 8, 20)
    ops.set_quota(ADMIN_SCOPE, "user", LEARNER, 0)
    assert quota.max_instances(LEARNER, ORG) == 0, "a changed quota is enforced by the next request"
    assert ops.reset_setting(ADMIN_SCOPE, "candidate_retention_days").value == 180
    assert scalar(owner, "SELECT count(*) FROM settings WHERE key = 'candidate_retention_days'") == 0
    ops.remove_quota(ADMIN_SCOPE, "user", LEARNER)
    with pytest.raises(NotFound):
        ops.remove_quota(ADMIN_SCOPE, "user", LEARNER)
    assert [a for a in (r.action for r in audit.records)].count("admin.quota_changed") == 3


def test_an_admin_decides_a_company_and_locks_a_user_on_the_real_tables(sessions, companies, owner):
    from test_companies import signup
    ops, _, audit = make_ops(sessions, companies, owner)
    signup(companies)
    with owner.begin() as c:
        c.execute(text("UPDATE users SET email_verified_at = now() WHERE email_ci = 'ana@acme.example'"))
    [pending] = ops.queue(ADMIN_SCOPE)
    ops.decide_company(ADMIN_SCOPE, pending.org_id, "approve")
    assert ops.queue(ADMIN_SCOPE) == []
    assert scalar(owner, "SELECT status FROM organizations WHERE id = :i", i=pending.org_id) == "active"
    ana = scalar(owner, "SELECT id FROM users WHERE email_ci = 'ana@acme.example'")
    assert ops.act_on_user(ADMIN_SCOPE, ana, "lock", "test") == "locked" and scalar(owner, "SELECT status FROM users WHERE id = :i", i=ana) == "disabled"
    assert [u.user_id for u in ops.users(ADMIN_SCOPE, query="acme.example", status="disabled")] == [ana]
    assert ops.act_on_user(ADMIN_SCOPE, ana, "unlock", "test") == "unlocked"


def test_the_capacity_view_counts_the_queue_on_the_real_tables(sessions, companies, owner):
    ops, _, _ = make_ops(sessions, companies, owner)
    with owner.begin() as c:
        c.execute(text("INSERT INTO domain_events (type, payload, created_at) VALUES ('attempt.state_changed', '{}'::jsonb, now())"))
    view = ops.capacity(ADMIN_SCOPE)
    assert view["queue"]["events_unpublished"] >= 1 and view["memory"] is None
    with owner.begin() as c:
        c.execute(text("DELETE FROM domain_events"))
