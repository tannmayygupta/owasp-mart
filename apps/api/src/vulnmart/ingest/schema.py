"""Schema check of one wire event (contracts/events/instance-events.schema.json) plus the rules JSON Schema cannot write.

Same answers as the Node fake (`schemaErrors`, `semanticEvent`): a list of (pointer, detail) pairs, empty when the event is
valid. A detail is a fixed text per keyword and never holds the offending value; a property name that looks like a flag is never
echoed in a pointer. `jsonschema` is imported on first use (it is a dev dependency of the api package today; the ingest
service needs it at run time, see the story notes).
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[5]
DEFAULT_SCHEMA = ROOT / "contracts" / "events" / "instance-events.schema.json"
SCHEMA_ENV = "VULNMART_EVENT_SCHEMA"
_FLAG_NAME = re.compile(r"[Vv][Mm](?:\{|%7[Bb]|｛)[^/]*")
_DETAILS = {
    "required": "is required",
    "additionalProperties": "has a property that is not allowed",
    "unevaluatedProperties": "has a property that is not allowed",
    "type": "has the wrong type",
    "enum": "is not an allowed value",
    "const": "is not the allowed value",
    "pattern": "does not match the expected format",
    "format": "does not match the expected format",
    "minimum": "is too small",
    "maximum": "is too large",
    "exclusiveMinimum": "is too small",
    "exclusiveMaximum": "is too large",
    "minLength": "is too short",
    "maxLength": "is too long",
    "minItems": "has too few items",
    "maxItems": "has too many items",
    "propertyNames": "has a property name that is not allowed",
}


def _esc(s: object) -> str:
    return str(s).replace("~", "~0").replace("/", "~1")


def redact_path(p: str) -> str:
    return _FLAG_NAME.sub("<redacted>", p)


def _pattern(validator: Any, patrn: str, instance: Any, schema: Any):
    """`pattern` with ECMAScript meaning of a final `$` (end of text only; Python's `$` also matches before a final newline)."""
    if validator.is_type(instance, "string"):
        py = patrn[:-1] + r"\Z" if patrn.endswith("$") and not patrn.endswith("\\$") else patrn
        if re.search(py, instance) is None:
            yield _error(f"{instance!r} does not match {patrn!r}")


def _error(message: str):
    from jsonschema.exceptions import ValidationError
    return ValidationError(message)


@lru_cache(maxsize=4)
def _validator(path: str):
    from jsonschema import validators
    base = validators.Draft202012Validator
    cls = validators.extend(base, {"pattern": _pattern})
    return cls(json.loads(Path(path).read_text(encoding="utf-8")))


def schema_path() -> Path:
    return Path(os.environ.get(SCHEMA_ENV) or DEFAULT_SCHEMA)


def parse_ts(value: str) -> datetime | None:
    """A UTC timestamp `YYYY-MM-DDTHH:MM:SS[.f]Z`; None when it is not a real time."""
    try:
        return datetime.fromisoformat(value).astimezone(UTC)
    except (ValueError, TypeError, OverflowError):
        return None


def semantic_errors(event: Mapping[str, Any]) -> list[tuple[str, str]]:
    """Rules that compare two fields (the fake's `semanticEvent`)."""
    out: list[tuple[str, str]] = []
    data = event.get("data")
    if (event.get("type") == "proxy.flag_seen" and isinstance(data, dict) and event.get("challenge_key") is not None
            and data.get("challenge_key") is not None and event["challenge_key"] != data["challenge_key"]):
        out.append(("/challenge_key", "must equal data.challenge_key when both are present"))
    return out


def schema_errors(event: Any, path: str | Path | None = None) -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []

    def add(pointer: str, detail: str) -> None:
        if (pointer, detail) not in seen:
            seen.add((pointer, detail))
            out.append((pointer, detail))

    errors = list(_validator(str(path or schema_path())).iter_errors(event))
    if not errors:
        for p, d in semantic_errors(event):
            add(p, d)
        return out
    for e in errors:
        if e.validator in ("if", "then", "else"):
            continue  # the wrapper adds no information
        base = "".join("/" + _esc(x) for x in e.absolute_path)
        if e.validator == "required":
            instance = e.instance if isinstance(e.instance, dict) else {}
            for name in e.validator_value:
                if name not in instance:
                    add(redact_path(f"{base}/{_esc(name)}"), _DETAILS["required"])
        else:
            add(redact_path(base), _DETAILS.get(str(e.validator), "is not valid"))
    return out
