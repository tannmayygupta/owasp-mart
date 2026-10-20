"""Story P-31 against a real Postgres 18 as the application role: migration 0016 down and up, and the privileges of `break_glass_sessions` (insert and select; update only
`closed_at`, `what_read` and the review; never who, which attempt, why or when; the reviewer is never the session's own admin; no delete). Skipped unless
VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import vulnmart.admin.models  # noqa: F401
from support import ROOT
from test_companies_postgres import APP, OWNER, app_engine, clean, database, owner  # noqa: F401
from test_kernel_postgres import with_db

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")


@pytest.fixture(autouse=True)
def clean_sessions(owner):
    with owner.begin() as c:
        c.execute(text("DELETE FROM break_glass_sessions"))
    yield


def insert(engine, sid="g-AAAAAAAAAAAAAAAA", admin="u-ADMINADMINADMIN2"):
    with engine.begin() as c:
        c.execute(text("INSERT INTO break_glass_sessions (id, admin_id, attempt_id, org_id, reason, started_at, expires_at) "
                       "VALUES (:i, :a, 'a-AAAAAAAAAAAAAAAA', '6f1c8f0e-0a5e-4a1c-9d5a-3f2d6a8b9c01', 'a reason of twenty characters', now(), now() + interval '15 minutes')"),
                  {"i": sid, "a": admin})


def test_migration_0016_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0015")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('break_glass_sessions')")).scalar_one() is None
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('break_glass_sessions')")).scalar_one() is not None


def test_the_application_role_records_reads_closing_and_review_but_never_rewrites_who_why_or_when(app_engine):
    insert(app_engine)
    with app_engine.begin() as c:
        c.execute(text("UPDATE break_glass_sessions SET what_read = '[{\"at\": \"x\", \"what\": [\"report\"]}]', closed_at = now() WHERE id = 'g-AAAAAAAAAAAAAAAA'"))
        c.execute(text("UPDATE break_glass_sessions SET reviewed_by = 'u-OTHERADMINOTHER2', reviewed_at = now(), review_note = 'ok' WHERE id = 'g-AAAAAAAAAAAAAAAA'"))
    for column, value in (("admin_id", "'u-SOMEONEELSEXXXX'"), ("attempt_id", "'a-BBBBBBBBBBBBBBBB'"), ("reason", "'rewritten'"), ("started_at", "now()"),
                          ("expires_at", "now() + interval '1 day'"), ("org_id", "'x'")):
        with pytest.raises(DBAPIError, match="permission denied"):
            with app_engine.begin() as c:
                c.execute(text(f"UPDATE break_glass_sessions SET {column} = {value}"))
    with pytest.raises(DBAPIError, match="permission denied"):
        with app_engine.begin() as c:
            c.execute(text("DELETE FROM break_glass_sessions"))


def test_the_table_refuses_a_review_by_the_session_s_own_admin_and_a_window_that_ends_before_it_starts(app_engine):
    insert(app_engine)
    with pytest.raises(DBAPIError, match="ck_break_glass_sessions_other_reviewer"):
        with app_engine.begin() as c:
            c.execute(text("UPDATE break_glass_sessions SET reviewed_by = 'u-ADMINADMINADMIN2', reviewed_at = now()"))
    with pytest.raises(DBAPIError, match="ck_break_glass_sessions_window"):
        with app_engine.begin() as c:
            c.execute(text("INSERT INTO break_glass_sessions (id, admin_id, attempt_id, org_id, reason, started_at, expires_at) "
                           "VALUES ('g-BBBBBBBBBBBBBBBB', 'u-A', 'a-A', 'o', 'a reason of twenty characters', now(), now() - interval '1 minute')"))
