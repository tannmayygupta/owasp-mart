"""Milestone rules as data (story 6.3, D-74): loader, matcher helpers and validator.

The rules live in `milestone_rules.json` next to this file. Five rule kinds cover all 33 milestones: `event`, `any`, `count`
(with optional `group_by`, `sum_field` and `then`), `count_distinct`, `flag` and `negative_window`. There is no per-challenge
Python; a rule edit changes behaviour. The catalogue's `signal` text is never read here.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

RULES_PATH = Path(__file__).with_name("milestone_rules.json")
ENVELOPE_FIELDS = frozenset({"session_kind", "challenge_key"})
MILESTONES = ("m1", "m2", "m3")
KINDS = frozenset({"event", "any", "count", "count_distinct", "flag", "negative_window"})
_OPS = frozenset({"in", "ne", "nonempty", "contains"})


class RulesInvalid(ValueError):
    """The rules file or a rule in it is malformed. The text names the place, never a value of an event."""


def load_rules(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or RULES_PATH).read_text(encoding="utf-8"))
    problems = validate_structure(data)
    if problems:
        raise RulesInvalid("; ".join(problems[:5]))
    return data


# ---- the where matcher ----

def field_value(event: Mapping[str, Any], name: str) -> Any:
    if name in ENVELOPE_FIELDS:
        return event.get(name)
    return (event.get("data") or {}).get(name)


def match_where(where: Mapping[str, Any], event: Mapping[str, Any]) -> bool:
    for name, cond in where.items():
        value = field_value(event, name)
        if isinstance(cond, dict):
            if "in" in cond and value not in cond["in"]:
                return False
            if "ne" in cond and value == cond["ne"]:
                return False
            if "nonempty" in cond and bool(value) != bool(cond["nonempty"]):
                return False
            if "contains" in cond and not (isinstance(value, (list, tuple)) and cond["contains"] in value):
                return False
        elif value != cond or type(value) is not type(cond):
            return False
    return True


# ---- introspection ----

def rule_types(rule: Mapping[str, Any]) -> frozenset[str]:
    """Every event type a rule reads (used to evaluate only the rules an incoming event can change)."""
    kind = rule["kind"]
    if kind == "any":
        out: set[str] = set()
        for sub in rule["of"]:
            out |= rule_types(sub)
        return frozenset(out)
    if kind == "flag":
        return frozenset({"proxy.flag_seen"})
    if kind == "negative_window":
        return frozenset({rule["failures"]["type"], rule["success"]["type"], rule["absent"]["type"]})
    out2 = {rule["type"]}
    if "then" in rule:
        out2.add(rule["then"]["type"])
    return frozenset(out2)


# ---- validation ----

def _where_problems(where: Any, place: str) -> list[str]:
    if not isinstance(where, dict):
        return [f"{place}: where must be an object"]
    out = []
    for name, cond in where.items():
        if isinstance(cond, dict) and (not cond or not set(cond) <= _OPS):
            out.append(f"{place}: where {name} has an unknown operator")
    return out


def _rule_problems(rule: Any, place: str) -> list[str]:
    if not isinstance(rule, dict) or rule.get("kind") not in KINDS:
        return [f"{place}: unknown or missing kind"]
    kind = rule["kind"]
    out: list[str] = []
    if kind == "flag":
        return out
    if kind == "any":
        subs = rule.get("of")
        if not isinstance(subs, list) or not subs:
            return [f"{place}: any needs a list in of"]
        for n, sub in enumerate(subs):
            out += _rule_problems(sub, f"{place}.of[{n}]")
        return out
    if kind == "negative_window":
        for part in ("failures", "success", "absent"):
            if not isinstance(rule.get(part), dict) or not isinstance(rule[part].get("type"), str):
                out.append(f"{place}: {part} needs a type")
        for num in ("window_s", "grace_s"):
            if type(rule.get(num)) is not int or rule[num] < 0:
                out.append(f"{place}: {num} must be a non-negative integer")
        if not isinstance(rule.get("group_by"), str):
            out.append(f"{place}: group_by is required")
        if not out:
            for part in ("failures", "success"):
                out += _where_problems(rule[part].get("where", {}), f"{place}.{part}")
            if type(rule["failures"].get("at_least")) is not int:
                out.append(f"{place}: failures.at_least must be an integer")
        return out
    if not isinstance(rule.get("type"), str):
        return [f"{place}: type is required"]
    out += _where_problems(rule.get("where", {}), place)
    if kind in ("count", "count_distinct") and type(rule.get("at_least")) is not int:
        out.append(f"{place}: at_least must be an integer")
    if kind == "count_distinct" and not isinstance(rule.get("field"), str):
        out.append(f"{place}: field is required")
    if "then" in rule:
        if kind != "count" or not isinstance(rule["then"], dict) or not isinstance(rule["then"].get("type"), str):
            out.append(f"{place}: then is only for count and needs a type")
        else:
            out += _where_problems(rule["then"].get("where", {}), f"{place}.then")
    return out


def validate_structure(data: Any) -> list[str]:
    """Shape problems of the rules file; an empty list means well formed. All 11 challenges need m1, m2 and m3."""
    if not isinstance(data, dict) or data.get("schema_version") != "0.1" or not isinstance(data.get("challenges"), dict):
        return ["file: schema_version 0.1 and challenges are required"]
    out: list[str] = []
    for ck, ms in data["challenges"].items():
        if not isinstance(ms, dict) or set(ms) != set(MILESTONES):
            out.append(f"{ck}: needs exactly m1, m2, m3")
            continue
        for m in MILESTONES:
            out += _rule_problems(ms[m], f"{ck}.{m}")
        if isinstance(ms.get("m3"), dict) and ms["m3"].get("kind") != "flag":
            out.append(f"{ck}.m3: must be the flag kind (M3 only from a verified flag)")
    return out


def _data_fields(schema: Mapping[str, Any], event_type: str) -> set[str] | None:
    """The data fields of an event type in the IF-4 schema, or None when the type or its data definition is unknown."""
    if event_type not in schema["properties"]["type"]["enum"]:
        return None
    definition = schema["$defs"].get("data_" + event_type.replace(".", "_"))
    return set(definition["properties"]) if definition else None


def _names_in(rule: Mapping[str, Any]) -> list[tuple[str, str, str]]:
    """(event type, field, place) for every field a rule reads."""
    out: list[tuple[str, str, str]] = []
    kind = rule["kind"]
    if kind == "any":
        for sub in rule["of"]:
            out += _names_in(sub)
    elif kind == "negative_window":
        for part in ("failures", "success"):
            t = rule[part]["type"]
            out += [(t, f, part) for f in rule[part].get("where", {})]
            out.append((t, rule["group_by"], "group_by"))
        out.append((rule["absent"]["type"], rule["group_by"], "group_by"))
    elif kind != "flag":
        t = rule["type"]
        out += [(t, f, "where") for f in rule.get("where", {})]
        for extra in ("field", "group_by", "sum_field"):
            if extra in rule:
                out.append((t, rule[extra], extra))
        if "then" in rule:
            tt = rule["then"]["type"]
            out += [(tt, f, "then") for f in rule["then"].get("where", {})]
    return out


def _types_in(rule: Mapping[str, Any]) -> list[str]:
    return sorted(rule_types(rule) - {"proxy.flag_seen"}) if rule["kind"] != "flag" else []


def validate_against_schema(data: Mapping[str, Any], schema: Mapping[str, Any]) -> list[str]:
    """Problems against `instance-events.schema.json`: an unknown event type, or a `where`, `field`, `group_by` or `sum_field`
    name that the type's data definition (or the envelope) does not have."""
    out: list[str] = []
    for ck, ms in data["challenges"].items():
        for m, rule in ms.items():
            place = f"{ck}.{m}"
            for t in _types_in(rule):
                if _data_fields(schema, t) is None:
                    out.append(f"{place}: event type {t} is not in the schema")
            for t, f, where in _names_in(rule):
                fields = _data_fields(schema, t)
                if fields is not None and f not in fields and f not in ENVELOPE_FIELDS:
                    out.append(f"{place}: {t} has no field {f} ({where})")
    return out
