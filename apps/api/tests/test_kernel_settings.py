"""Process settings from the environment, the SettingsPort over the `settings` table, and the one Alembic history."""
from __future__ import annotations

import json
import subprocess
import sys

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401
import vulnmart.orgs.models  # noqa: F401
from support import ROOT
from vulnmart.kernel.db import Base
from vulnmart.kernel.models import SettingRow
from vulnmart.kernel.settings import DbSettingsPort, Settings, sqlalchemy_url
from vulnmart.ports.errors import UnknownSetting
from vulnmart.ports.settings import SETTINGS, SettingsPort

ALEMBIC_INI = ROOT / "apps" / "api" / "alembic.ini"


# ---- process settings ----

def test_settings_come_from_vulnmart_variables_and_hide_addresses(monkeypatch):
    monkeypatch.setenv("VULNMART_POSTGRES_DSN", "postgresql://vulnmart_app:pw-123@db:5432/vulnmart")
    monkeypatch.setenv("VULNMART_SERVICE", "worker")
    monkeypatch.setenv("VULNMART_VERSION", "1.0.0")
    s = Settings()
    assert (s.service, s.version, s.check_timeout_seconds) == ("worker", "1.0.0", 2.0)
    assert "pw-123" not in repr(s) and "pw-123" not in str(s)


@pytest.mark.parametrize(("name", "value"), [("VULNMART_SERVICE", "shop"), ("VULNMART_LOG_LEVEL", "LOUD"), ("VULNMART_CHECK_TIMEOUT_SECONDS", "0")])
def test_bad_settings_stop_the_process(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        Settings()


def test_sqlalchemy_url_uses_the_psycopg_driver():
    assert sqlalchemy_url("postgresql://u:p@h:5432/d") == "postgresql+psycopg://u:p@h:5432/d"
    assert sqlalchemy_url("postgres://u@h/d") == "postgresql+psycopg://u@h/d"
    assert sqlalchemy_url("postgresql+psycopg://u@h/d") == "postgresql+psycopg://u@h/d"
    with pytest.raises(ValueError):
        sqlalchemy_url("mysql://u@h/d")


# ---- SettingsPort over the settings table ----

@pytest.fixture
def port():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine)
    yield DbSettingsPort(sessions), sessions
    engine.dispose()


def test_a_setting_without_a_row_reads_its_default_and_a_row_overrides_it(port):
    settings, sessions = port
    assert isinstance(settings, SettingsPort)
    assert settings.get("session_idle_minutes") == SETTINGS["session_idle_minutes"]
    with sessions() as s:
        s.add(SettingRow(key="session_idle_minutes", value=20, updated_by="s-admin"))
        s.commit()
    assert settings.get("session_idle_minutes") == 20


def test_an_unknown_name_or_a_wrongly_typed_row_is_refused(port):
    settings, sessions = port
    with pytest.raises(UnknownSetting):
        settings.get("session_idle_minuets")
    with sessions() as s:
        s.add(SettingRow(key="hints_enabled_default", value="yes"))
        s.commit()
    with pytest.raises(UnknownSetting):
        settings.get("hints_enabled_default")


# ---- the one Alembic history ----

def test_the_history_has_one_root_and_one_head():
    script = ScriptDirectory.from_config(Config(str(ALEMBIC_INI)))
    assert script.get_heads() == ["0001"]
    assert [r.revision for r in script.walk_revisions()] == ["0001"]


def test_stream_l_single_head_check_passes():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_alembic_head.py"), "--root", str(ROOT)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("PASS")


def test_the_offline_sql_creates_the_five_tables_with_forced_row_level_security(monkeypatch):
    monkeypatch.setenv("VULNMART_MIGRATE_DSN", "postgresql://owner@localhost/vulnmart")
    r = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), "upgrade", "head", "--sql"],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert r.returncode == 0, r.stderr
    sql = r.stdout
    for table in ("settings", "quotas", "job_runs", "organizations", "org_members"):
        assert f"CREATE TABLE {table}" in sql, table
    for table in ("organizations", "org_members"):
        assert f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql
        assert f"CREATE POLICY org_scope ON {table}" in sql
    assert "current_setting('vulnmart.org_id', true)" in sql
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON settings, quotas, job_runs, organizations, org_members TO vulnmart_app" in sql
    assert "BYPASSRLS" not in sql and "OWNER TO vulnmart_app" not in sql, "the app role gets row rights only"


def test_migrations_refuse_to_run_without_an_address(monkeypatch):
    monkeypatch.delenv("VULNMART_MIGRATE_DSN", raising=False)
    monkeypatch.delenv("VULNMART_POSTGRES_DSN", raising=False)
    r = subprocess.run([sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), "upgrade", "head", "--sql"], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode != 0
    assert "VULNMART_MIGRATE_DSN" in (r.stdout + r.stderr)


def test_every_table_of_the_metadata_is_in_the_table_owners_file():
    import yaml

    owners = {row["table"] for row in yaml.safe_load((ROOT / "contracts" / "db" / "table-owners.yaml").read_text(encoding="utf-8"))["tables"]}
    assert set(Base.metadata.tables) <= owners
    assert json.dumps(sorted(Base.metadata.tables)) == json.dumps(["job_runs", "org_members", "organizations", "quotas", "settings"])
