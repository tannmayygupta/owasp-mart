"""Process settings (environment) and the SettingsPort over the `settings` table.

Two kinds of setting, kept apart on purpose:
- `Settings`: how this process starts (database and Valkey addresses, service name, version, log level). Read once
  from `VULNMART_*` environment variables; never stored in the database.
- `DbSettingsPort`: the values the admin may change at run time (timeouts, caps), the closed list of
  `vulnmart.ports.settings.SETTINGS`, stored in the `settings` table; a name with no row reads its default.

Database addresses use the `postgresql://` form of libpq; `sqlalchemy_url` turns one into the psycopg driver URL.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.errors import UnknownSetting
from vulnmart.ports.settings import SETTINGS

ServiceName = Literal["api", "ingest", "live", "worker", "scheduler", "migrate"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VULNMART_", extra="ignore", frozen=True)

    postgres_dsn: str | None = Field(default=None, repr=False)  # the app role (no table owner, no BYPASSRLS)
    migrate_dsn: str | None = Field(default=None, repr=False)  # the owner role; only the migrate job has it
    valkey_url: str | None = Field(default=None, repr=False)
    service: ServiceName = "api"
    version: str = "0.0.0-dev"
    commit: str = "unknown"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    check_timeout_seconds: float = Field(default=2.0, gt=0, le=30)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def sqlalchemy_url(dsn: str) -> str:
    """`postgresql://user:pw@host/db` -> `postgresql+psycopg://user:pw@host/db` (psycopg 3 driver)."""
    for prefix in ("postgresql+psycopg://", "postgresql://", "postgres://"):
        if dsn.startswith(prefix):
            return "postgresql+psycopg://" + dsn[len(prefix):]
    raise ValueError("a Postgres DSN starts with postgresql://")


class DbSettingsPort:
    """SettingsPort over the `settings` table: a row overrides the default of `SETTINGS`; values are JSON."""

    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def get(self, name: str) -> int | bool | str:
        from .models import SettingRow  # the models import the metadata of this package

        if name not in SETTINGS:
            raise UnknownSetting(f"unknown setting {name!r}")
        with self._sessions() as session:
            raw = session.execute(select(SettingRow.value).where(SettingRow.key == name)).scalar_one_or_none()
        if raw is None:
            return SETTINGS[name]
        value = raw  # the JSON column hands back the decoded value
        default = SETTINGS[name]
        if type(value) is not type(default):
            raise UnknownSetting(f"setting {name!r} holds a {type(value).__name__}, not a {type(default).__name__}")
        return value
