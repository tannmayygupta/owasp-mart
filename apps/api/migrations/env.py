"""Alembic environment: the metadata of every module, the address from the environment, one transaction per run."""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

import vulnmart.kernel.models  # noqa: F401 - registers the kernel tables
import vulnmart.notifications.models  # noqa: F401 - registers the email outbox
import vulnmart.orgs.models  # noqa: F401 - registers the organisation tables
from vulnmart.kernel.db import Base
from vulnmart.kernel.settings import sqlalchemy_url

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)  # Alembic's INFO lines ("Running upgrade ...")
target_metadata = Base.metadata


def database_url() -> str:
    dsn = os.environ.get("VULNMART_MIGRATE_DSN") or os.environ.get("VULNMART_POSTGRES_DSN")
    if not dsn:
        raise SystemExit("Set VULNMART_MIGRATE_DSN (the owner role) to run migrations.")
    return sqlalchemy_url(dsn)


def run_migrations_offline() -> None:
    context.configure(url=database_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = engine_from_config({"sqlalchemy.url": database_url()}, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True, transaction_per_migration=False)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
