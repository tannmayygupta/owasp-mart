"""Story P-31 (FR-PRV-20, D-95): the incident notice reaches every active affected account once, skips the others, and leaves one audit entry with counts, never
the text."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from test_companies import T0, audit, clock, sessions  # noqa: F401
from vulnmart.accounts.models import User
from vulnmart.admin.incident import notify_affected
from vulnmart.notifications.models import EmailOutbox

A, B, GONE = "u-AAAAAAAAAAAAAAAA", "u-BBBBBBBBBBBBBBBB", "u-GONEGONEGONEGONE"


def user(sessions, uid, status="active"):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="participant", email=f"{uid}@example.org", email_ci=f"{uid.lower()}@example.org", password_hash="x", display_name=uid,
                   status=status, email_verified_at=T0))


def test_every_active_affected_account_is_told_once_and_the_audit_has_counts_only(sessions, audit, clock):
    user(sessions, A)
    user(sessions, B)
    user(sessions, GONE, status="deleted")
    told, skipped = notify_affected(sessions, audit, [A, B, A, GONE, "u-NOBODYNOBODYNOBO", ""], summary="A test incident with  spaces.",
                                    advice="Change your password.", now=clock)
    assert (told, skipped) == (2, 2)
    with sessions() as s:
        rows = s.scalars(select(EmailOutbox).where(EmailOutbox.template == "security.incident_notice")).all()
    assert sorted(r.to_user_id for r in rows) == [A, B] and rows[0].params["summary"] == "A test incident with spaces."
    [record] = [r for r in audit.records if r.action == "incident.notified"]
    assert record.details == {"told": 2, "skipped": 2} and "incident with" not in repr(audit.records)


@pytest.mark.parametrize("summary,advice,ids", [("", "x", [A]), ("x" * 601, "x", [A]), ("x", "x", ["not-an-id"])])
def test_a_bad_text_or_id_is_refused_and_nothing_is_queued(sessions, audit, clock, summary, advice, ids):
    with pytest.raises(ValueError):
        notify_affected(sessions, audit, ids, summary=summary, advice=advice, now=clock)
    with sessions() as s:
        assert s.scalars(select(EmailOutbox)).all() == []
