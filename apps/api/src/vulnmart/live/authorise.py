"""Which streams a signed-in person may read (story P-23, FR-LIV-05, ADR 0052). Decided here, on the server, from the session and the state of the company, and nothing the
client sends is an input.

- everyone: their own user stream (`live:user:<id>`), which carries only events of their own attempts;
- a recruiter: also the stream of their company (`live:org:<id>`), and only while they are an **active** recruiter of an **active** company acting for it (the session
  carries the company of an active membership whatever the company's state, so the company's own standing is asked here: a pending, rejected or suspended company, a
  suspended recruiter or a removed member has no company stream);
- an admin whose session proved a second factor (the session only has the admin role then): also the admin stream.

`StreamAuthoriser.streams` is called when a connection opens and again every time the hub re-checks the session, so a change of any of these ends an open connection.
With no way to ask for the company's standing it grants no company stream (fail closed).
"""
from __future__ import annotations

import logging
from collections.abc import Callable

from vulnmart.accounts.sessions import ResolvedSession
from vulnmart.orgs.service import NotActiveRecruiter, NotARecruiter
from vulnmart.ports.scope import Role

logger = logging.getLogger("vulnmart.live")


class StreamAuthoriser:
    def __init__(self, active_company_of: Callable[[str], str] | None = None):
        self._active_company_of = active_company_of

    def streams(self, session: ResolvedSession) -> list[str]:
        keys = [f"live:user:{session.user.id}"]
        if Role.RECRUITER in session.roles and session.org_id and self._company_is_active(session):
            keys.append(f"live:org:{session.org_id}")
        if Role.ADMIN in session.roles:
            keys.append("live:admin")
        return keys

    def _company_is_active(self, session: ResolvedSession) -> bool:
        if self._active_company_of is None:
            return False
        try:
            return self._active_company_of(session.user.id) == session.org_id
        except (NotActiveRecruiter, NotARecruiter):
            return False
        except Exception:  # noqa: BLE001 - a store failure must not grant a stream
            logger.exception("the standing of a recruiter's company could not be read: no company stream")
            return False
