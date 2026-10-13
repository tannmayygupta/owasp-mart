"""Strict JSON for the IF-5 wire rules (contract section 2a, ADR 0028, D2 of story 3.2).

`json.loads` alone cannot tell `1` from `1.0`, accepts `NaN`, keeps the last of two equal keys and reads a huge integer exactly.
This reader keeps the standard library parser (so the grammar is RFC 8259) and changes three results:

- an integer token inside 0 to 2^53 - 1 (or its negative) is a plain `int`; a bigger one is an `OutOfRangeInt`, which is an `int`
  subclass, so a check `type(v) is int` refuses it and names the field;
- a number with a fraction or an exponent is a `FloatToken`, a `float` subclass, so the same check refuses it (only `cpu_limit`
  accepts a float, and compares it by value);
- `NaN`, `Infinity`, a duplicate key, a nesting deeper than 32 and anything that is not UTF-8 are refused.

Booleans stay booleans: `type(True) is bool`, not `int`.
"""
from __future__ import annotations

import json

MAX_INT = 2**53 - 1
MAX_DEPTH = 32
_MAX_DIGITS = 17  # 2^53 - 1 has 16 digits; anything longer is out of range without converting it


class JsonStrictError(ValueError):
    """The body is not JSON this API accepts. The message never holds the body."""


class FloatToken(float):
    """A number written with a fraction or an exponent (`1.0`, `1e0`, `2.5`)."""


class OutOfRangeInt(int):
    """An integer token above 2^53 - 1 in size."""


def _parse_int(token: str) -> int:
    digits = token.lstrip("-")
    if len(digits) > _MAX_DIGITS:
        return OutOfRangeInt(MAX_INT + 1)  # too long to be in range: not converted, the value is a stand-in
    value = int(token)
    return value if -MAX_INT <= value <= MAX_INT else OutOfRangeInt(value)


def _parse_float(token: str) -> float:
    return FloatToken(token)


def _parse_constant(token: str):
    raise JsonStrictError("NaN and Infinity are not JSON")


def _pairs(pairs: list[tuple[str, object]]) -> dict:
    out: dict[str, object] = {}
    for k, v in pairs:
        if k in out:
            raise JsonStrictError("a member name is repeated")
        out[k] = v
    return out


def _depth_ok(raw: str) -> bool:
    """A cheap bound on nesting before the parser sees the text: brackets inside strings are counted too, which only makes this
    stricter, and a legitimate IF-5 body is three levels deep."""
    depth = deepest = 0
    in_string = escaped = False
    for ch in raw:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            deepest = max(deepest, depth)
            if deepest > MAX_DEPTH:
                return False
        elif ch in "]}":
            depth -= 1
    return True


def loads_strict(payload: bytes | str) -> object:
    """Read a request body. Raises `JsonStrictError` for anything the contract refuses at the syntax level."""
    try:
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
    except UnicodeDecodeError:
        raise JsonStrictError("the body is not UTF-8") from None
    if not _depth_ok(text):
        raise JsonStrictError("the body is nested too deep")
    try:
        return json.loads(
            text, parse_int=_parse_int, parse_float=_parse_float, parse_constant=_parse_constant, object_pairs_hook=_pairs,
        )
    except JsonStrictError:
        raise
    except (ValueError, RecursionError):
        raise JsonStrictError("the body is not valid JSON") from None
