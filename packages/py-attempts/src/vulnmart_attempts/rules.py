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

    def __post_init__(self) -> None:
        if min(self.min_capture_seconds, self.idle_capture_seconds, self.instant_capture_seconds,
               self.withdrawal_undo_days) < 0:
            raise ValueError("integrity thresholds and the undo window cannot be negative")
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
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Rules:
        defaults = cls()
        return cls(
            time_limit_minutes=int(data.get("time_limit_minutes", defaults.time_limit_minutes)),  # type: ignore[arg-type]
            grace_seconds=int(data.get("grace_seconds", defaults.grace_seconds)),  # type: ignore[arg-type]
            warning_minutes=tuple(int(m) for m in data.get("warning_minutes", defaults.warning_minutes)),  # type: ignore[attr-defined]
            freeze_minutes=int(data.get("freeze_minutes", defaults.freeze_minutes)),  # type: ignore[arg-type]
            reset_limit=int(data.get("reset_limit", defaults.reset_limit)),  # type: ignore[arg-type]
            min_capture_seconds=int(data.get("min_capture_seconds", defaults.min_capture_seconds)),  # type: ignore[arg-type]
            idle_capture_seconds=int(data.get("idle_capture_seconds", defaults.idle_capture_seconds)),  # type: ignore[arg-type]
            instant_capture_seconds=int(data.get("instant_capture_seconds", defaults.instant_capture_seconds)),  # type: ignore[arg-type]
            activity_check_mode=str(data.get("activity_check_mode", defaults.activity_check_mode)),
            withdrawal_undo_days=int(data.get("withdrawal_undo_days", defaults.withdrawal_undo_days)),  # type: ignore[arg-type]
        )
