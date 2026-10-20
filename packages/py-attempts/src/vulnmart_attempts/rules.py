"""The rules copied from the template when an attempt starts (all numbers are placeholders, OI-25)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class Rules:
    time_limit_minutes: int = 120
    grace_seconds: int = 60
    warning_minutes: tuple[int, ...] = field(default=(15, 5))
    freeze_minutes: int = 15
    reset_limit: int = 3
    # Integrity placeholders (OI-25, FR-ACH-03: real numbers come from pilot data).
    min_capture_seconds: int = 60
    idle_capture_seconds: int = 1800
    instant_capture_seconds: int = 5
    activity_check_mode: str = "hold"  # D-94: "hold" or "flag" (flag only, the capture counts)
    withdrawal_undo_days: int = 7
    results_visibility: str = "after_submit"  # H-355, OI-15: "after_submit" or "after_release" (the recruiter releases the candidate's results)

    def __post_init__(self) -> None:
        if min(self.min_capture_seconds, self.idle_capture_seconds, self.instant_capture_seconds,
               self.withdrawal_undo_days) < 0:
            raise ValueError("integrity thresholds and the undo window cannot be negative")
        if self.results_visibility not in ("after_submit", "after_release"):
            raise ValueError("results_visibility must be 'after_submit' or 'after_release'")
        if self.activity_check_mode not in ("hold", "flag"):
            raise ValueError("activity_check_mode must be 'hold' or 'flag'")
        if self.time_limit_minutes <= 0:
            raise ValueError("time_limit_minutes must be positive")
        if self.grace_seconds < 0 or self.freeze_minutes < 0 or self.reset_limit < 0:
            raise ValueError("grace_seconds, freeze_minutes and reset_limit cannot be negative")
        warnings = tuple(self.warning_minutes)
        if any(m <= 0 or m >= self.time_limit_minutes for m in warnings):
            raise ValueError("each warning must be between 0 and the time limit (exclusive)")
        if len(set(warnings)) != len(warnings):
            raise ValueError("warning minutes must be unique")
        object.__setattr__(self, "warning_minutes", tuple(sorted(warnings, reverse=True)))

    def to_dict(self) -> dict[str, object]:
        """The shape stored in the attempts `rules` jsonb column."""
        return {
            "time_limit_minutes": self.time_limit_minutes,
            "grace_seconds": self.grace_seconds,
            "warning_minutes": list(self.warning_minutes),
            "freeze_minutes": self.freeze_minutes,
            "reset_limit": self.reset_limit,
            "min_capture_seconds": self.min_capture_seconds,
            "idle_capture_seconds": self.idle_capture_seconds,
            "instant_capture_seconds": self.instant_capture_seconds,
            "activity_check_mode": self.activity_check_mode,
            "withdrawal_undo_days": self.withdrawal_undo_days,
            "results_visibility": self.results_visibility,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Rules:
        """Strict: an unknown member, a float, a string or a bool where a whole number belongs is a ValueError, never a silent cut (finding B12)."""
        defaults = cls()
        unknown = set(data) - set(defaults.to_dict())
        if unknown:
            raise ValueError(f"unknown rule member: {sorted(unknown)[0]}")

        def whole(key: str) -> int:
            value = data.get(key, getattr(defaults, key))
            if type(value) is not int:
                raise ValueError(f"{key} must be a whole number")
            return value

        warnings = data.get("warning_minutes", defaults.warning_minutes)
        if not isinstance(warnings, (list, tuple)) or any(type(m) is not int for m in warnings):
            raise ValueError("warning_minutes must be a list of whole numbers")
        mode = data.get("activity_check_mode", defaults.activity_check_mode)
        if not isinstance(mode, str):
            raise ValueError("activity_check_mode must be text")
        visibility = data.get("results_visibility", defaults.results_visibility)
        if not isinstance(visibility, str):
            raise ValueError("results_visibility must be text")
        return cls(
            time_limit_minutes=whole("time_limit_minutes"), grace_seconds=whole("grace_seconds"), warning_minutes=tuple(warnings),
            freeze_minutes=whole("freeze_minutes"), reset_limit=whole("reset_limit"), min_capture_seconds=whole("min_capture_seconds"),
            idle_capture_seconds=whole("idle_capture_seconds"), instant_capture_seconds=whole("instant_capture_seconds"),
            activity_check_mode=mode, withdrawal_undo_days=whole("withdrawal_undo_days"), results_visibility=visibility,
        )