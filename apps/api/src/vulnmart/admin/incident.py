"""Telling the people affected by an incident (story P-31, FR-PRV-20; D-95: a short procedure, no time target, a draft for legal review).

`python -m vulnmart.admin.incident --user-ids-file affected.txt --summary "..." --advice "..."` runs on the server, inside the API container. It queues the email
`security.incident_notice` to every active account in the file (one user id per line; the procedure in `docs/runbooks/incident-procedure.md` says how the list is
found, for example from the admin's audit log), and writes one audit entry `incident.notified` with how many were told, never the text. Unknown or deleted accounts are
skipped and counted. Exit codes: 0 done, 2 a value is not acceptable, 1 anything else.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Callable, Iterable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort

USER_ID = re.compile(r"^u-[A-Z2-7]{16}$")
TEXT_MAX = 600


def notify_affected(sessions: sessionmaker[Session], audit: AuditPort, user_ids: Iterable[str], *, summary: str, advice: str, actor: str = "operator:incident",
                    now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> tuple[int, int]:
    """Queue the notice to each active account; returns (told, skipped). Raises ValueError for an empty or too long text or a malformed id."""
    summary, advice = " ".join(summary.split()), " ".join(advice.split())
    if not (1 <= len(summary) <= TEXT_MAX and 1 <= len(advice) <= TEXT_MAX):
        raise ValueError(f"the summary and the advice are 1 to {TEXT_MAX} characters")
    ids = sorted({i.strip() for i in user_ids if i.strip()})
    bad = [i for i in ids if not USER_ID.match(i)]
    if bad:
        raise ValueError(f"not user ids: {bad[:3]}")
    with sessions.begin() as session:
        active = set(session.scalars(select(User.id).where(User.id.in_(ids), User.status == "active")).all()) if ids else set()
        outbox = DbOutboxPort(lambda: session, None, now=now, validator=validate_params)
        for uid in sorted(active):
            outbox.enqueue_email(template="security.incident_notice", to_user_id=uid, params={"summary": summary, "advice": advice})
    audit.append(actor=actor, action="incident.notified", subject=None, details={"told": len(active), "skipped": len(ids) - len(active)})
    return len(active), len(ids) - len(active)


def main(argv: list[str] | None = None, *, out=None, err=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m vulnmart.admin.incident", description="Email the incident notice to the affected accounts (FR-PRV-20).")
    parser.add_argument("--user-ids-file", required=True, help="a file with one user id per line")
    parser.add_argument("--summary", required=True, help="what happened, in plain words")
    parser.add_argument("--advice", required=True, help="what the person can do")
    args = parser.parse_args(argv)
    out, err = out or sys.stdout, err or sys.stderr
    from vulnmart.kernel.services import build_ports
    from vulnmart.kernel.settings import Settings

    settings = Settings()
    if not settings.postgres_dsn:
        print("VULNMART_POSTGRES_DSN is not set: there is no database.", file=err)
        return 1
    ports = build_ports(settings)
    try:
        with open(args.user_ids_file, encoding="utf-8") as f:
            told, skipped = notify_affected(ports.sessions, ports.audit, f.read().splitlines(), summary=args.summary, advice=args.advice)
    except ValueError as exc:
        print(str(exc), file=err)
        return 2
    print(f"told {told}, skipped {skipped}", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
