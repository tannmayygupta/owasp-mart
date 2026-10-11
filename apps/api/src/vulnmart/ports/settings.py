"""SettingsPort: timeouts and caps (IF-9, provided by stream P).

Settings are a closed list: a name that is not in `SETTINGS` is a programming error (UnknownSetting), so a typo
never silently reads a default. The defaults are the placeholders of the requirements; the admin changes the
values in the `settings` table later (FR-ADM).
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

# name -> default. The type of the default is the type of the setting.
SETTINGS: dict[str, int | bool | str] = {
    "session_idle_minutes": 30,  # FR-ACC-04
    "session_idle_minutes_admin": 15,  # FR-ACC-04
    "session_absolute_hours": 12,  # FR-ACC-04
    "instance_idle_minutes": 30,  # FR-INS (placeholder until spike S-4)
    "instance_max_minutes": 240,  # FR-INS (placeholder)
    "hints_enabled_default": True,
    "evidence_max_bytes": 8192,  # FR-DET-03
    "learner_evidence_days": 30,  # FR-PRV-06
    "candidate_retention_days": 180,  # FR-PRV-04
    "consent_withdraw_undo_days": 7,  # FR-PRV-08
    "flag_submit_per_minute": 10,  # FR-FLG (placeholder)
}


@runtime_checkable
class SettingsPort(Protocol):
    def get(self, name: str) -> int | bool | str:
        """The current value. Raises UnknownSetting for a name that is not in `SETTINGS`."""
        ...
