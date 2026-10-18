"""Classify a candidate flag by recomputing it (story 6.1, D-72). There is no flag table and nothing is stored.

Order: correct (this instance, current epoch), decoy (this instance, current epoch), stale_epoch (this instance, an earlier
epoch, real flag or decoy), other_instance (a listed other instance, any epoch up to its current one), wrong. All compares are
`hmac.compare_digest` over SHA-256 hex digests. The checker takes a `KeyPort` Protocol only, never a key and never the fake.
No log line, exception text or `repr` holds a candidate or a flag.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from dataclasses import field as dc_field
from enum import StrEnum

from vulnmart.flags.material import CHALLENGE_KEYS, DEFAULT_DECOYS, MAX_DECOYS, MAX_EPOCH_WALK, sha256_hex
from vulnmart.ports.keys import KeyPort

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


class FlagClass(StrEnum):
    CORRECT = "correct"
    DECOY = "decoy"
    STALE_EPOCH = "stale_epoch"
    OTHER_INSTANCE = "other_instance"
    WRONG = "wrong"


@dataclass(frozen=True, slots=True)
class FlagCheck:
    """The result of one check. Holds no flag and no candidate."""

    flag_class: FlagClass
    challenge_key: str | None = None
    other_instance_id: str | None = None  # set for OTHER_INSTANCE only
    epoch: int | None = None  # the epoch the candidate belonged to (stale_epoch, other_instance)


def candidate_digest(candidate: str) -> str:
    """SHA-256 hex of a candidate text; what the sidecar sends as `candidate_sha256`."""
    return sha256_hex(candidate)


@dataclass(slots=True)
class FlagChecker:
    keys: KeyPort = dc_field(repr=False)
    decoys_per_challenge: int = DEFAULT_DECOYS

    def __post_init__(self) -> None:
        if type(self.decoys_per_challenge) is not int or not 0 <= self.decoys_per_challenge <= MAX_DECOYS:
            raise ValueError(f"decoys per challenge must be 0 to {MAX_DECOYS}")

    # ---- the compare, one place so a test can spy on it ----
    @staticmethod
    def _eq(a: str, b: str) -> bool:
        return hmac.compare_digest(a, b)

    def _match(self, digest: str, instance_id: str, epoch: int, challenge_keys: Iterable[str]) -> tuple[bool, str] | None:
        """(is_real, challenge_key) when `digest` is a flag or decoy of this instance epoch, else None.
        Every candidate value is compared (no early exit) so the time does not tell which one matched."""
        found: tuple[bool, str] | None = None
        for c in challenge_keys:
            if self._eq(digest, sha256_hex(self.keys.flag(instance_id, c, epoch))) and found is None:
                found = (True, c)
            for i in range(self.decoys_per_challenge):
                if self._eq(digest, sha256_hex(self.keys.decoy(instance_id, c, epoch, i))) and found is None:
                    found = (False, c)
        return found

    def classify(
        self,
        candidate: str | None,
        *,
        instance_id: str,
        epoch: int,
        challenge_keys: Iterable[str] = CHALLENGE_KEYS,
        other_instances: Mapping[str, int] | Iterable[str] = (),
        candidate_sha256: str | None = None,
    ) -> FlagCheck:
        """Classify a candidate text, or only its SHA-256 (`candidate_sha256`, the sidecar's field).

        `challenge_keys` are the challenges of this instance. `other_instances` are the instances to test against: a mapping
        of instance id to its current epoch, or a plain list (epoch 1 to this instance's epoch is tried for each).
        Raises `ValueError` with a fixed message on bad input.
        """
        if type(epoch) is not int or epoch < 1:
            raise ValueError("epoch must be a positive integer")
        if not isinstance(instance_id, str) or not instance_id:
            raise ValueError("instance_id must be a non-empty string")
        if candidate_sha256 is not None:
            digest = candidate_sha256.strip().lower()
            if not _SHA256_HEX.match(digest):
                raise ValueError("candidate_sha256 must be 64 hex characters")
        elif isinstance(candidate, str):
            digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
        else:
            raise ValueError("a candidate text or candidate_sha256 is required")
        ckeys = tuple(challenge_keys)

        hit = self._match(digest, instance_id, epoch, ckeys)
        if hit is not None:
            return FlagCheck(FlagClass.CORRECT if hit[0] else FlagClass.DECOY, hit[1], None, epoch)

        walk_from = max(1, epoch - MAX_EPOCH_WALK)
        for e in range(epoch - 1, walk_from - 1, -1):
            hit = self._match(digest, instance_id, e, ckeys)
            if hit is not None:
                return FlagCheck(FlagClass.STALE_EPOCH, hit[1], None, e)

        others = dict(other_instances) if isinstance(other_instances, Mapping) else {i: epoch for i in other_instances}
        for other_id, other_epoch in others.items():
            if other_id == instance_id:
                continue
            top = other_epoch if type(other_epoch) is int and other_epoch >= 1 else epoch
            for e in range(top, max(1, top - MAX_EPOCH_WALK) - 1, -1):
                hit = self._match(digest, other_id, e, ckeys)
                if hit is not None:
                    return FlagCheck(FlagClass.OTHER_INSTANCE, hit[1], other_id, e)

        return FlagCheck(FlagClass.WRONG)
