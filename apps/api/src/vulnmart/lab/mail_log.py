"""The attempt log that also tells the mail triggers (FR-NTF-01, FR-NTF-04, finding F-10 of the 2026-10-21 wiring audit).

Every fact that deserves a mail is already written to the ids-only attempt log by the one place that causes it: the engine's clock (`time_warning_sent`, `session_submitted`), the
withdrawal (`attempt_withdrawn`) and the release route (`results_released`). Wrapping the log means no caller has to remember to send a mail, and a new caller of `append` is
covered. The mail is attempted only after the log accepted the line, so a refused line (unknown field, no attempt id) causes no mail. A mail that fails never fails the write:
the triggers log and answer 0, and this wrapper catches anything else.

The sink is set by the application after the mail triggers exist (`LabRuntime.mail_log.sink`); without one the wrapper is the plain log.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from vulnmart_attempts.attempt_log import EngineBridge

log = logging.getLogger("vulnmart.lab.mail")

# the events that cause a mail; every other event passes through untouched
MAIL_EVENTS = frozenset({"time_warning_sent", "session_submitted", "attempt_withdrawn", "results_released"})


class MailingAttemptLog(EngineBridge):
    def __init__(self, inner: Any, sink: Callable[[Mapping[str, Any]], None] | None = None) -> None:
        self._inner = inner
        self.sink = sink

    def append(self, event: Mapping[str, Any]) -> None:
        self._inner.append(event)
        if self.sink is not None and event.get("event") in MAIL_EVENTS:
            try:
                self.sink(event)
            except Exception:  # noqa: BLE001 - a mail must never undo or fail the step that caused it
                log.exception("the mail for %s could not be started", event.get("event"))

    def read(self, attempt_id: str):
        return self._inner.read(attempt_id)

    def read_keyed(self, attempt_id: str):
        return self._inner.read_keyed(attempt_id)

    def __getattr__(self, name: str) -> Any:  # anything else the real log offers (stores keep extras)
        return getattr(self._inner, name)


def mail_sink(triggers: Any) -> Callable[[Mapping[str, Any]], None]:
    """The sink that turns a log line into the matching `MailTriggers` call."""

    def sink(event: Mapping[str, Any]) -> None:
        name, attempt_id = event.get("event"), str(event.get("attempt_id"))
        if name == "time_warning_sent":
            triggers.time_warning(attempt_id, int(event.get("minutes_left") or 0))
        elif name == "session_submitted":
            triggers.submission_received(attempt_id)
        elif name == "attempt_withdrawn":
            triggers.consent_withdrawn(attempt_id, deletion_on=event.get("delete_after"))
        elif name == "results_released":
            triggers.results_released(attempt_id)

    return sink
