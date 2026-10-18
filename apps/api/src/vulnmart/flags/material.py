"""Flag material of one instance epoch (create and reset), story 6.1, D-71 and D-72.

`build_material` derives everything through the `KeyPort` Protocol (`flag`, `decoy`, `event_key`); it never sees a key and it
imports no fake. The caller (the composition root) decides which KeyPort it passes. There is no flag table: the checker
recomputes the same values.

Nothing here logs or puts a flag into an error text. `FlagMaterial` and its entries already hide their secret fields from `repr`.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Iterable

from vulnmart.ports.instance_host import DecoyEntry, DigestEntry, FlagEntry, FlagMaterial
from vulnmart.ports.keys import KeyPort

CHALLENGE_KEYS = tuple(f"C{n:02d}" for n in range(1, 12))
_CHALLENGE = re.compile(r"^C(?:0[1-9]|1[01])$")
MAX_DECOYS = 4
DEFAULT_DECOYS = 2
MAX_EPOCH_WALK = 50  # the checker tries epochs 1..current, at most this many

# Where a decoy may be put, one plain line per challenge, no flag in it. IF-5 `FlagMaterial` has no field for it and the
# catalogue has no decoy location yet (handoff to Sahil, T-30): `build_material` does not return these texts; the injector
# reads them from here or from the catalogue.
DECOY_PLACEMENT: dict[str, str] = {
    "C01": "an order note of a seeded customer that the signed-in player cannot normally open",
    "C02": "a stale backup export file name listed on an operations page",
    "C03": "a hidden internal product description reachable only by a crafted search",
    "C04": "a note on a refund record that is not the player's own",
    "C05": "a comment on the verbose error page of a disabled route",
    "C06": "a version banner of a bundled component on an old admin page",
    "C07": "a stored remark on a locked staff account",
    "C08": "a field inside an unsigned import file template",
    "C09": "a line in the shop's own security log of a seeded account",
    "C10": "a body returned by an internal-only metadata address",
    "C11": "a value in the debug section of a failed checkout response",
}


def _validate(instance_id: str, epoch: int, challenge_keys: Iterable[str], decoys_per_challenge: int) -> tuple[str, ...]:
    if not isinstance(instance_id, str) or not instance_id or not instance_id.isascii():
        raise ValueError("instance_id must be a non-empty ASCII string")
    if type(epoch) is not int or epoch < 1:
        raise ValueError("epoch must be a positive integer")
    keys = tuple(challenge_keys)
    if not 1 <= len(keys) <= len(CHALLENGE_KEYS):
        raise ValueError("between 1 and 11 challenge keys are required")
    if len(set(keys)) != len(keys):
        raise ValueError("challenge keys must be unique")
    if any(not isinstance(k, str) or not _CHALLENGE.match(k) for k in keys):
        raise ValueError("a challenge key must be C01 to C11")
    if type(decoys_per_challenge) is not int or not 0 <= decoys_per_challenge <= MAX_DECOYS:
        raise ValueError(f"decoys per challenge must be 0 to {MAX_DECOYS}")
    return keys


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_material(
    keys: KeyPort,
    instance_id: str,
    epoch: int,
    challenge_keys: Iterable[str],
    *,
    decoys_per_challenge: int = DEFAULT_DECOYS,
    seed: str | None = None,
) -> FlagMaterial:
    """The IF-5 `FlagMaterial` of `(instance_id, epoch)`.

    One flag per challenge key, `decoys_per_challenge` decoys each (index 0..n-1), the SHA-256 digests of the real flags only
    (the orchestrator adds the decoy digests itself), the event key of the instance epoch and a seed. The seed is the only
    random part: 43 URL-safe characters from `secrets.token_urlsafe(32)`, fresh per call; a reset passes `epoch + 1` and gets
    a new seed. Raises `ValueError` with a fixed message (no secret in it) on bad input.
    """
    ckeys = _validate(instance_id, epoch, challenge_keys, decoys_per_challenge)
    flags = tuple(FlagEntry(c, keys.flag(instance_id, c, epoch)) for c in ckeys)
    decoys = tuple(DecoyEntry(c, i, keys.decoy(instance_id, c, epoch, i)) for c in ckeys for i in range(decoys_per_challenge))
    real = {f.flag for f in flags}
    if len(real) != len(flags) or any(d.value in real for d in decoys) or len({d.value for d in decoys}) != len(decoys):
        raise ValueError("flag derivation produced a collision")  # a guard; the derivation labels differ
    digests = tuple(DigestEntry(f.challenge_key, sha256_hex(f.flag)) for f in flags)
    return FlagMaterial(
        flags=flags,
        decoys=decoys,
        flag_digests=digests,
        event_key=keys.event_key(instance_id, epoch),
        seed=seed if seed is not None else secrets.token_urlsafe(32),
    )
