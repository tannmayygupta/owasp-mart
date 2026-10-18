"""Integrity detectors (FR-ACH-03, FR-ACH-04, FR-ACH-06, D-94). Pure, standard library only.

Every detector returns plain facts. A signal is evidence for a human: nothing here changes a score, rejects or
zeroes anyone. Write-up text is an input to a function only; it is never stored, logged or returned.
"""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from itertools import combinations
from typing import Protocol

SIMILARITY_THRESHOLD = 0.8  # PRD placeholder: pairs strictly above it are flagged
SHINGLE_WORDS = 3
_WORD = re.compile(r"\w+")


def too_fast(capture_s: float, minimum_s: float) -> bool:
    """True when the capture came sooner than the minimum plausible time (strictly less; equal is fine)."""
    if capture_s < 0 or minimum_s < 0:
        raise ValueError("seconds cannot be negative")
    return capture_s < minimum_s


def after_long_idle(idle_s: float, limit_s: float, capture_after_resume_s: float, instant_s: float) -> bool:
    """True when the user was idle for `limit_s` or longer and the capture came within `instant_s` of resuming."""
    if min(idle_s, limit_s, capture_after_resume_s, instant_s) < 0:
        raise ValueError("seconds cannot be negative")
    return idle_s >= limit_s and capture_after_resume_s <= instant_s


def shingles(text: str, size: int = SHINGLE_WORDS) -> frozenset[tuple[str, ...]]:
    """Word n-grams of the lower-cased text. Fewer than `size` words gives no shingles (never flagged)."""
    words = _WORD.findall(text.lower())
    return frozenset(tuple(words[i:i + size]) for i in range(len(words) - size + 1))


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


@dataclass(frozen=True, slots=True)
class SimilarPair:
    first: str  # attempt ids only, first < second
    second: str
    score: float


def similar_writeups(texts: Mapping[str, str], threshold: float = SIMILARITY_THRESHOLD) -> tuple[SimilarPair, ...]:
    """Pairs of attempts of ONE assessment whose write-ups have 3-gram Jaccard similarity above `threshold`."""
    sets = {attempt_id: shingles(text) for attempt_id, text in texts.items()}
    out = []
    for a, b in combinations(sorted(sets), 2):
        score = jaccard(sets[a], sets[b])
        if score > threshold:
            out.append(SimilarPair(a, b, round(score, 4)))
    return tuple(out)


def similar_across(entries: Iterable[tuple[str, str, str]], threshold: float = SIMILARITY_THRESHOLD) -> tuple[SimilarPair, ...]:
    """`(assessment_id, attempt_id, text)` rows; compares only within one assessment."""
    groups: dict[str, dict[str, str]] = defaultdict(dict)
    for assessment_id, attempt_id, text in entries:
        groups[assessment_id][attempt_id] = text
    out: list[SimilarPair] = []
    for assessment_id in sorted(groups):
        out.extend(similar_writeups(groups[assessment_id], threshold))
    return tuple(out)


@dataclass(frozen=True, slots=True)
class Signal:
    attempt_id: str
    kind: str  # "timing" or "similarity" (the platform's IntegrityType words)
    explanation: str  # plain language, no text of any write-up, no flag
    dedupe_key: str  # one flag per cause


class IntegritySink(Protocol):
    def add(self, attempt_id: str, kind: str, explanation: str, dedupe_key: str) -> bool: ...


def timing_signals(attempt_id: str, challenge_key: str, capture_s: float, minimum_s: float,
                   idle_s: float | None = None, idle_limit_s: float | None = None,
                   capture_after_resume_s: float | None = None, instant_s: float | None = None) -> tuple[Signal, ...]:
    out: list[Signal] = []
    if too_fast(capture_s, minimum_s):
        out.append(Signal(attempt_id, "timing",
                          f"{challenge_key} was captured {int(capture_s)} s into the assessment, sooner than the "
                          f"{int(minimum_s)} s minimum plausible time. Evidence for a human, not a decision.",
                          f"timing-fast-{challenge_key}"))
    if None not in (idle_s, idle_limit_s, capture_after_resume_s, instant_s) and \
            after_long_idle(idle_s, idle_limit_s, capture_after_resume_s, instant_s):  # type: ignore[arg-type]
        out.append(Signal(attempt_id, "timing",
                          f"{challenge_key} was captured {int(capture_after_resume_s)} s after a "  # type: ignore[arg-type]
                          f"{int(idle_s)} s idle period. Evidence for a human, not a decision.",  # type: ignore[arg-type]
                          f"timing-idle-{challenge_key}"))
    return tuple(out)


def similarity_signals(pairs: Iterable[SimilarPair]) -> tuple[Signal, ...]:
    """One flag per pair on each attempt of the pair; ids and the score only."""
    out: list[Signal] = []
    for p in pairs:
        for mine, other in ((p.first, p.second), (p.second, p.first)):
            out.append(Signal(mine, "similarity",
                              f"The write-up is {round(p.score * 100)}% similar to the write-up of attempt {other} "
                              "in the same assessment. Evidence for a human review, not a decision.",
                              f"similarity-{p.first}-{p.second}"))
    return tuple(out)


def raise_signals(sink: IntegritySink, signals: Iterable[Signal]) -> int:
    """Write the signals (deduplicated by the sink). Returns how many were new. Never touches a score."""
    return sum(1 for s in signals if sink.add(s.attempt_id, s.kind, s.explanation, s.dedupe_key))


def capture_treatment(activity_check_mode: str, consistent: bool) -> str:
    """D-94: "counts" (consistent), "held" (inconsistent, mode hold) or "flagged" (inconsistent, mode flag: the
    capture counts and a flag is raised). Nothing here ever gives a zero."""
    if activity_check_mode not in ("hold", "flag"):
        raise ValueError("activity_check_mode must be 'hold' or 'flag'")
    if consistent:
        return "counts"
    return "held" if activity_check_mode == "hold" else "flagged"
