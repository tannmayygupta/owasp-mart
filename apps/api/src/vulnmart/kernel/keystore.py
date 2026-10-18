"""The keystore database `vm_keystore` (story P-17, architecture 04 sections 5.2 and 5.3, ADR 0008): its tables and how the migrate job prepares it.

The wrapped per-attempt keys live in a database of their own, reached with a role of their own (`vulnmart_keys`), so that the nightly dump of
`vulnmart` never contains a key and a key can be shredded without touching the data. `deks` holds one wrapped key per attempt; `shredded` holds only the
ids of attempts whose key was deleted (so a later call is told "shredded", not "never existed"). The tables are not part of the `vulnmart` metadata
and have no Alembic history: `ensure_keystore` creates them idempotently and records a schema version.
"""
from __future__ import annotations

import logging
import re

from sqlalchemy import BigInteger, Column, Integer, LargeBinary, MetaData, String, Table, create_engine, func, text
from sqlalchemy.engine import make_url
from sqlalchemy.types import DateTime

from .settings import sqlalchemy_url

logger = logging.getLogger("vulnmart.keystore")

SCHEMA_VERSION = 1
NAME = re.compile(r"^[a-z][a-z0-9_]{0,62}$")

metadata = MetaData()

deks = Table(
    "deks", metadata,
    Column("attempt_id", String(64), primary_key=True),
    Column("dek_id", String(40), nullable=False, unique=True),
    Column("kek_version", Integer, nullable=False),
    Column("nonce", LargeBinary(12), nullable=False),
    Column("wrapped", LargeBinary(48), nullable=False),  # 32-byte key + 16-byte GCM tag
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)
shredded = Table(
    "shredded", metadata,
    Column("attempt_id", String(64), primary_key=True),
    Column("shredded_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)
schema_version = Table("keystore_schema", metadata, Column("version", BigInteger, primary_key=True))


def _check_name(value: str, what: str) -> str:
    if not NAME.match(value):
        raise ValueError(f"{what} {value!r} is not a plain lower-case name")
    return value


def with_database(dsn: str, database: str) -> str:
    """The same server and credentials, another database."""
    return make_url(sqlalchemy_url(dsn)).set(database=database).render_as_string(hide_password=False)


def ensure_keystore(owner_dsn: str, *, database: str, role: str, role_password: str) -> None:
    """Create (idempotently) the keystore database, its role and its tables, as the owner role. The role may reach only this database; it may read,
    insert and delete wrapped keys, update them (a KEK rotation rewraps) and record shredded ids, and nothing else."""
    _check_name(database, "keystore database")
    _check_name(role, "keystore role")
    if len(role_password) < 16:
        raise ValueError("the keystore role password is at least 16 characters")
    server = create_engine(sqlalchemy_url(owner_dsn), isolation_level="AUTOCOMMIT")
    try:
        with server.connect() as c:
            if c.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}).first() is None:  # the name is checked above, so quoting it is safe
                c.exec_driver_sql(f'CREATE ROLE "{role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
            alter = c.execute(text("SELECT format('ALTER ROLE %I PASSWORD %L', CAST(:r AS text), CAST(:p AS text))"), {"r": role, "p": role_password}).scalar_one()
            c.exec_driver_sql(alter)  # the server quotes the literal; the password never appears in a log of ours
            if c.execute(text("SELECT 1 FROM pg_database WHERE datname = :d"), {"d": database}).first() is None:
                c.exec_driver_sql(f'CREATE DATABASE "{database}"')
            c.exec_driver_sql(f'REVOKE ALL ON DATABASE "{database}" FROM PUBLIC')
            c.exec_driver_sql(f'GRANT CONNECT ON DATABASE "{database}" TO "{role}"')
    finally:
        server.dispose()
    keystore = create_engine(sqlalchemy_url(with_database(owner_dsn, database)))
    try:
        with keystore.begin() as c:
            metadata.create_all(c)
            c.execute(text("INSERT INTO keystore_schema (version) VALUES (:v) ON CONFLICT DO NOTHING"), {"v": SCHEMA_VERSION})
            c.exec_driver_sql("REVOKE ALL ON SCHEMA public FROM PUBLIC")
            c.exec_driver_sql(f'GRANT USAGE ON SCHEMA public TO "{role}"')
            c.exec_driver_sql(f'REVOKE ALL ON deks, shredded, keystore_schema FROM "{role}"')
            c.exec_driver_sql(f'GRANT SELECT, INSERT, DELETE ON deks TO "{role}"')
            c.exec_driver_sql(f'GRANT UPDATE (kek_version, nonce, wrapped) ON deks TO "{role}"')  # a KEK rotation rewraps; nothing else changes
            c.exec_driver_sql(f'GRANT SELECT, INSERT ON shredded TO "{role}"')
            c.exec_driver_sql(f'GRANT SELECT ON keystore_schema TO "{role}"')
    finally:
        keystore.dispose()
    logger.info("keystore database %s is ready", database)
