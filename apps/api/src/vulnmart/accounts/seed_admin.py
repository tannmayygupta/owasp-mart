"""The seed command for the first admin (FR-ACC-11): `python -m vulnmart.accounts.seed_admin --email you@example.org --name "Your Name"`.

Run it on the server, inside the API container (it reads the same `VULNMART_POSTGRES_DSN`). The password never goes on the command line:
it comes from `VULNMART_SEED_ADMIN_PASSWORD`, or from one line on standard input with `--password-stdin`, or (neither given) the command
makes a random one and prints it once. At least 16 characters. The account exists at once. It signs in with the password, but a session
without a proved second factor has no admin role: the first thing the admin does is set up an authenticator app (story P-15). Nothing is changed when an account with that address exists already (exit code 3).

Exit codes: 0 created, 2 a value is not acceptable, 3 the address already has an account, 1 anything else. The audit entry (`admin.created`) goes to the
durable audit log in the same database, pseudonymised like every other entry (story P-17; story 1.9 replaced the in-memory stand-in).
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys

from vulnmart.kernel.audit import DbAuditPort
from vulnmart.kernel.db import make_engine, make_sessions
from vulnmart.kernel.settings import DbSettingsPort, Settings
from vulnmart.privacy.subjects import PseudonymisingAudit, SubjectService

from .admins import AdminService
from .passwords import make_policy
from .service import InvalidInput

def parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m vulnmart.accounts.seed_admin", description="Create the first admin account (FR-ACC-11).")
    parser.add_argument("--email", required=True, help="the admin's email address")
    parser.add_argument("--name", required=True, help="the display name (1 to 60 characters)")
    parser.add_argument("--password-stdin", action="store_true", help="read the password from one line of standard input")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, *, settings: Settings | None = None, stdin=None, out=None, err=None) -> int:
    args = parse(argv)
    settings = settings or Settings()
    stdin, out, err = stdin or sys.stdin, out or sys.stdout, err or sys.stderr
    if not settings.postgres_dsn:
        print("VULNMART_POSTGRES_DSN is not set: there is no database to seed.", file=err)
        return 1
    generated = False
    if args.password_stdin:
        password = stdin.readline().rstrip("\r\n")
    elif os.environ.get("VULNMART_SEED_ADMIN_PASSWORD"):
        password = os.environ["VULNMART_SEED_ADMIN_PASSWORD"]
    else:
        password, generated = secrets.token_urlsafe(18), True  # 24 characters
    sessions = make_sessions(make_engine(settings.postgres_dsn), lambda: None)
    audit = PseudonymisingAudit(DbAuditPort(sessions), SubjectService(sessions))
    service = AdminService(sessions, DbSettingsPort(sessions), audit, public_origin=settings.public_origin, policy=make_policy(settings))
    try:
        created = service.seed_admin(email=args.email, display_name=args.name, password=password)
    except InvalidInput as exc:
        reason = {"/email": "the email address is not valid", "/display_name": "the name must be 1 to 60 characters"}.get(exc.pointer)
        if reason is None:
            reason = {"password_length": "the password must be 16 to 128 characters",
                      "password_common": "the password is too easy to guess",
                      "password_breached": "the password has appeared in a data breach",
                      "password_identity": "the password must not contain the email address or the name"}.get(exc.kind, "a value is not valid")
        print(f"Not created: {reason}.", file=err)
        return 2
    if not created:
        print("Nothing changed: an account with that address exists already.", file=err)
        return 3
    print("The admin account was created. It signs in with the password but has no admin powers until an authenticator app is set up.", file=out)
    if generated:
        print(f"Password (shown once, store it safely): {password}", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
