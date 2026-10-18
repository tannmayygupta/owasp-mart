"""The migrate job (`python -m vulnmart.kernel.migrate`): the Alembic history of `vulnmart`, then the keystore database.

Runs as the owner role (`VULNMART_MIGRATE_DSN`). When a keystore password is configured (`VULNMART_KEYSTORE_PASSWORD` or `..._FILE`) it also creates
`vm_keystore`, its role and its tables (story P-17); both steps are idempotent, so the job can run at every start.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config

from .keystore import ensure_keystore
from .settings import get_settings

logger = logging.getLogger("vulnmart.migrate")


def alembic_ini() -> Path:
    configured = os.environ.get("VULNMART_ALEMBIC_INI")
    if configured:
        return Path(configured)
    here = Path(__file__).resolve()
    for candidate in (Path("/app/alembic.ini"), here.parents[3] / "alembic.ini"):
        if candidate.exists():
            return candidate
    raise SystemExit("alembic.ini not found: set VULNMART_ALEMBIC_INI")


def main() -> int:
    settings = get_settings()
    if not settings.migrate_dsn:
        raise SystemExit("Set VULNMART_MIGRATE_DSN (the owner role) to run migrations.")
    command.upgrade(Config(str(alembic_ini())), "head")
    password = settings.keystore_password_value()
    if password:
        ensure_keystore(settings.migrate_dsn, database=settings.keystore_database, role=settings.keystore_role, role_password=password)
    else:
        print("keystore: no VULNMART_KEYSTORE_PASSWORD, so no keystore database was prepared", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
