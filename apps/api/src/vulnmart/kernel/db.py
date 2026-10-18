"""The database layer: one SQLAlchemy metadata, the engine, and sessions that enforce organisation scope (ADR 0014).

Every table of every module is declared on `Base` (one metadata, one Alembic history). A table that holds company
data is registered as org-scoped (`org_scoped`), and the session then guards it twice:

1. In Python: an ORM query that reads an org-scoped table while no organisation is in scope raises `ScopeMissing`
   (it never returns everything); with an organisation in scope, the filter `org_id = :org` is added to it.
2. In Postgres: every transaction sets `vulnmart.org_id` (`set_config(..., true)`, so it ends with the transaction
   and a pooled connection never carries it over), and the row-level security policies of the migration compare
   each row with it. The app role is not the table owner and has no BYPASSRLS, so the policies apply to it.

Limits of guard 1, each covered by guard 2: raw SQL (`text()`) is not inspected; a Core statement over a plain `Table`
of an org-scoped table is refused without an organisation in scope, but with one in scope only the row-level security
filters it (the session's filter attaches to mapped classes). Module code reads org-scoped tables through their mapped
classes; only migrations and the RLS tests use raw SQL.
"""
from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import Engine, MetaData, Table, Uuid, create_engine, event, text
from sqlalchemy.sql import visitors
from sqlalchemy.orm import DeclarativeBase, ORMExecuteState, Session, sessionmaker, with_loader_criteria

from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.scope import Scope

from .settings import sqlalchemy_url

# Constraint names Alembic can rely on (and that read well in a Postgres error).
NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

ORG_SETTING = "vulnmart.org_id"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


# table name -> the column that holds the organisation id
ORG_SCOPED: dict[str, str] = {}
# Tables an admin may READ across companies without an organisation in scope (story P-18: the company directory of the approval queue). Only
# company metadata is listed here, never a table that holds candidate data (the privacy wall of FR-DSH-06): a new table is not admin-visible unless
# its class says so, and its row-level security policy has to grant the same read on purpose.
ORG_ADMIN_VISIBLE: set[str] = set()
# Tables whose rows name a person (`user_column`): that person may read their own rows without an organisation in scope (story P-18: "which company am I in"),
# and nobody else's. The session adds `user_column = scope.user_id` and the database policy says the same.
ORG_SELF_VISIBLE: dict[str, str] = {}
ADMIN_SETTING = "vulnmart.admin"
USER_SETTING = "vulnmart.user_id"


def org_scoped(column: str = "org_id", *, admin_visible: bool = False, self_column: str | None = None) -> Callable[[type], type]:
    """Class decorator: register a mapped class as org-scoped on `column`. `admin_visible=True` lets an admin scope with no organisation read it;
    `self_column` names the column that holds a user id, so that user may read their own rows with no organisation in scope."""

    def mark(cls: type) -> type:
        ORG_SCOPED[cls.__tablename__] = column  # type: ignore[attr-defined]
        cls.__org_column__ = column  # type: ignore[attr-defined]
        if admin_visible:
            ORG_ADMIN_VISIBLE.add(cls.__tablename__)  # type: ignore[attr-defined]
        if self_column is not None:
            ORG_SELF_VISIBLE[cls.__tablename__] = self_column  # type: ignore[attr-defined]
        return cls

    return mark


def make_engine(dsn: str, **kwargs: Any) -> Engine:
    """A pooled engine for a `postgresql://` DSN (psycopg 3). `pool_pre_ping` drops connections Postgres closed."""
    return create_engine(sqlalchemy_url(dsn), pool_pre_ping=True, **kwargs)


ScopeSource = Callable[[], Scope | None]


class ScopedSession(Session):
    """A session that knows where to read the current scope from (`scope_source`, returning None when nothing is in scope)."""

    def __init__(self, *args: Any, scope_source: ScopeSource, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.scope_source = scope_source

    def admin_without_org(self) -> bool:
        """True for an admin scope that acts for no company: the only scope that may read an admin-visible table across companies."""
        scope = self.scope_source()
        return scope is not None and scope.is_admin and scope.org_id is None

    def current_org(self) -> str | None:
        """The organisation in scope in one canonical spelling (a UUID as lowercase with dashes), so the Python filter and
        the Postgres setting always name the same organisation."""
        scope = self.scope_source()
        if scope is None or scope.org_id is None:
            return None
        try:
            return str(uuid.UUID(str(scope.org_id)))
        except ValueError:
            return str(scope.org_id)


def _scoped_entities(state: ORMExecuteState) -> list[type]:
    """The org-scoped mapped classes a statement touches: its entities, and every table anywhere in it (a `select_from`,
    a join, a subquery, an aggregate over a table). `all_mappers` alone misses `select(func.count()).select_from(X)`."""
    names = {mapper.local_table.name for mapper in state.all_mappers}
    names |= {t.name for t in visitors.iterate(state.statement) if isinstance(t, Table)}
    found = []
    for name in sorted(names & ORG_SCOPED.keys()):
        cls = _class_of(name)
        if cls is not None:
            found.append(cls)
    return found


def _class_of(table: str) -> type | None:
    for mapper in Base.registry.mappers:
        if mapper.local_table.name == table:
            return mapper.class_
    return None


@event.listens_for(ScopedSession, "do_orm_execute")
def _guard_org_scope(state: ORMExecuteState) -> None:
    if not (state.is_select or state.is_update or state.is_delete):
        return
    session = state.session
    if not isinstance(session, ScopedSession):
        return
    entities = _scoped_entities(state)
    if not entities:
        return
    org = session.current_org()
    names = ", ".join(sorted(e.__tablename__ for e in entities))
    if org is None:
        if state.is_select and session.admin_without_org() and all(e.__tablename__ in ORG_ADMIN_VISIBLE for e in entities):
            return  # an admin reads the company directory across companies (no filter); the database policy grants the same read
        scope = session.scope_source()
        if state.is_select and scope is not None and all(e.__tablename__ in ORG_SELF_VISIBLE for e in entities):
            for cls in entities:  # a person reads their own rows only, whatever the query asks for
                state.statement = state.statement.options(with_loader_criteria(cls, getattr(cls, ORG_SELF_VISIBLE[cls.__tablename__]) == scope.user_id,
                                                                               include_aliases=True))
            return
        raise ScopeMissing(f"a query on {names} needs an organisation in scope")
    if "org_at_begin" in session.info and session.info["org_at_begin"] != org:
        # the Postgres setting was fixed when the transaction began: a different scope now would disagree with it
        raise ScopeMissing("the organisation in scope changed inside a transaction; commit or roll back first")
    for cls in entities:
        column = cls.__org_column__
        value = _org_value(cls, column, org)
        # A plain expression, not a lambda: SQLAlchemy caches lambda criteria by code location, which would reuse one
        # table's column for another (found by the tests of story P-06).
        state.statement = state.statement.options(with_loader_criteria(cls, getattr(cls, column) == value, include_aliases=True))


def _org_value(cls: type, column: str, org: str) -> Any:
    """The scope's organisation id in the column's type (a UUID column gets a UUID; a malformed id matches nothing)."""
    if isinstance(cls.__table__.c[column].type, Uuid):  # type: ignore[attr-defined]
        try:
            return org if isinstance(org, uuid.UUID) else uuid.UUID(str(org))
        except ValueError:
            raise ScopeMissing("the organisation in scope is not a valid id") from None
    return str(org)


@event.listens_for(ScopedSession, "after_begin")
def _set_org_setting(session: Session, transaction: Any, connection: Any) -> None:
    """Every transaction tells Postgres which organisation is in scope ('' when none: no org-scoped row matches)."""
    if not isinstance(session, ScopedSession):
        return
    org = session.current_org()
    session.info["org_at_begin"] = org
    if connection.dialect.name == "postgresql":
        connection.execute(text("SELECT set_config(:name, :value, true)"), {"name": ORG_SETTING, "value": org or ""})
        connection.execute(text("SELECT set_config(:name, :value, true)"),
                           {"name": ADMIN_SETTING, "value": "on" if org is None and session.admin_without_org() else ""})
        scope = session.scope_source()
        connection.execute(text("SELECT set_config(:name, :value, true)"), {"name": USER_SETTING, "value": scope.user_id if scope is not None else ""})


@event.listens_for(ScopedSession, "after_transaction_end")
def _forget_org(session: Session, transaction: Any) -> None:
    if transaction.parent is None:
        session.info.pop("org_at_begin", None)


def make_sessions(engine: Engine, scope_source: ScopeSource) -> sessionmaker[ScopedSession]:
    return sessionmaker(engine, class_=ScopedSession, expire_on_commit=False, scope_source=scope_source)
