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
    # Where this process runs. `staging` and `production` are strict: the service does not start without an origin secret (M11 of the
    # audit), because an unset secret switches the origin check off. `dev` (the default) and `test` keep the check optional.
    env: Literal["dev", "test", "staging", "production"] = "dev"
    service: ServiceName = "api"
    version: str = "0.0.0-dev"
    commit: str = "unknown"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    check_timeout_seconds: float = Field(default=2.0, gt=0, le=30)
    # The x-origin-secret value(s) the dashboards' proxy adds (comma-separated during a rotation); unset: no check.
    # Production reads it from a file (architecture 06 s3: secrets are files under /run/secrets); the file wins.
    origin_secret: str | None = Field(default=None, repr=False)
    origin_secret_file: str | None = None
    # Email (story P-09, OI-32 answer 2026-10-17: Brevo single sender). `smtp` talks to Mailpit in development; `brevo` uses the API.
    email_provider: Literal["smtp", "brevo"] = "smtp"
    email_sender_address: str = "no-reply@vulnmart.invalid"  # for Brevo: the verified single sender
    email_sender_name: str = "VulnMart"
    smtp_host: str | None = None
    smtp_port: int = Field(default=1025, ge=1, le=65535)
    smtp_starttls: bool = False
    smtp_username: str | None = None
    smtp_password: str | None = Field(default=None, repr=False)
    brevo_api_key: str | None = Field(default=None, repr=False)
    brevo_api_key_file: str | None = None  # production reads secrets from files (architecture 06 s3); the file wins
    email_relay_interval_seconds: float = Field(default=5.0, gt=0, le=600)
    # Accounts (story P-11). `public_origin` is the dashboards' address that links in mail point to (https in staging and production).
    public_origin: str = "http://127.0.0.1:3000"
    # How many proxies we run in front of the API and append to x-forwarded-for; the entry this many from the right is the visitor.
    # Counted only when an origin secret protects the API (architecture 03 rule 4). Behind caddy-p it will be 2 (see handoff H-129).
    trusted_proxy_hops: int = Field(default=1, ge=0, le=5)
    # The key of the CSRF token (HMAC of the session value, ADR 0019 M2; story P-12). Production reads a file (architecture 06 s3) and the
    # file wins; staging and production do not start without one. dev and test make a random key per process (tokens then end with it).
    csrf_secret: str | None = Field(default=None, repr=False)
    csrf_secret_file: str | None = None

    def csrf_key(self) -> bytes | None:
        """The configured CSRF key as bytes, or None when none is set."""
        if self.csrf_secret_file:
            with open(self.csrf_secret_file, encoding="utf-8") as f:
                value = f.read().strip()
        else:
            value = self.csrf_secret
        return value.encode("utf-8") if value else None

    def origin_secrets_value(self) -> str | None:
        """The configured origin secret(s): the file's content when a file is named, else the environment value."""
        if self.origin_secret_file:
            with open(self.origin_secret_file, encoding="utf-8") as f:
                return f.read().strip()
        return self.origin_secret

    def brevo_key_value(self) -> str | None:
        if self.brevo_api_key_file:
            with open(self.brevo_api_key_file, encoding="utf-8") as f:
                return f.read().strip()
        return self.brevo_api_key


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
