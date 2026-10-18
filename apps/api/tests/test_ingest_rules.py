"""Story 6.3: the rules file (D-74), its validation against the IF-4 schema and the catalogue tags (FR-DET-01)."""
from __future__ import annotations

import copy
import re
from pathlib import Path

import pytest
from ingest_support import CATALOG_DIR, load_schema

from vulnmart.ingest import engine as engine_module
from vulnmart.ingest import rules as R
from vulnmart.ingest.catalogue import load_catalogue, tags_of
from vulnmart.ports.reports import CHALLENGE_KEYS

RULES = R.load_rules()
SCHEMA = load_schema()


def test_all_33_milestones_have_a_rule_and_m3_is_the_flag_kind():
    assert tuple(RULES["challenges"]) == CHALLENGE_KEYS
    for ck, ms in RULES["challenges"].items():
        assert set(ms) == {"m1", "m2", "m3"}, ck
        assert ms["m3"] == {"kind": "flag"}, ck
        assert ms["m1"]["kind"] != "flag" and ms["m2"]["kind"] != "flag", ck


def test_rules_are_well_formed_and_match_the_event_schema():
    assert R.validate_structure(RULES) == []
    assert R.validate_against_schema(RULES, SCHEMA) == []


def test_an_event_type_or_field_that_is_not_in_the_schema_fails():
    bad = copy.deepcopy(RULES)
    bad["challenges"]["C05"]["m1"]["type"] = "shop.not_an_event"
    assert any("C05.m1" in p and "not in the schema" in p for p in R.validate_against_schema(bad, SCHEMA))
    bad = copy.deepcopy(RULES)
    bad["challenges"]["C05"]["m1"]["where"] = {"no_such_field": "x"}
    assert any("no_such_field" in p for p in R.validate_against_schema(bad, SCHEMA))
    bad = copy.deepcopy(RULES)
    bad["challenges"]["C09"]["m2"]["group_by"] = "nope"
    assert any("nope" in p for p in R.validate_against_schema(bad, SCHEMA))
    bad = copy.deepcopy(RULES)
    bad["challenges"]["C07"]["m2"]["of"][1]["sum_field"] = "nope"
    assert any("nope" in p for p in R.validate_against_schema(bad, SCHEMA))


def test_a_gap_fails_structure_validation():
    for mutate in (
        lambda d: d["challenges"]["C03"].pop("m2"),
        lambda d: d["challenges"]["C04"].__setitem__("m3", {"kind": "event", "type": "order.paid", "where": {}}),
        lambda d: d["challenges"]["C01"]["m1"].__setitem__("kind", "teleport"),
        lambda d: d["challenges"]["C02"]["m1"]["where"].__setitem__("result", {"regex": ".*"}),
        lambda d: d.__setitem__("schema_version", "9"),
    ):
        bad = copy.deepcopy(RULES)
        mutate(bad)
        assert R.validate_structure(bad), mutate


def test_no_per_challenge_python_and_no_copied_branches():
    for module in (engine_module,):
        text = Path(module.__file__).read_text(encoding="utf-8")
        assert not re.search(r"""["']C(0[1-9]|1[01])["']""", text), "engine code names a challenge key"
    submit = Path(engine_module.__file__).parents[1] / "flags" / "submit.py"
    assert not re.search(r"""["']C(0[1-9]|1[01])["']""", submit.read_text(encoding="utf-8"))
    rules = [RULES["challenges"][c][m] for c in CHALLENGE_KEYS for m in ("m1", "m2")]
    assert len({repr(sorted(r.items())) for r in rules}) == len(rules)  # no two milestones share a rule


def test_where_matcher():
    ev = {"session_kind": "player", "data": {"a": 1, "b": "x", "tags": ["t1", "t2"], "empty": [], "flag": True}}
    m = R.match_where
    assert m({}, ev) and m({"b": "x"}, ev) and not m({"b": "y"}, ev)
    assert m({"b": {"in": ["x", "z"]}}, ev) and not m({"b": {"in": ["z"]}}, ev)
    assert m({"b": {"ne": "y"}}, ev) and not m({"b": {"ne": "x"}}, ev)
    assert m({"tags": {"nonempty": True}}, ev) and not m({"empty": {"nonempty": True}}, ev)
    assert m({"tags": {"contains": "t2"}}, ev) and not m({"tags": {"contains": "t3"}}, ev)
    assert m({"flag": True}, ev) and not m({"flag": False}, ev)
    assert not m({"a": True}, ev)  # 1 is not True
    assert m({"session_kind": "player"}, ev) and not m({"missing": "x"}, ev)


def test_catalogue_has_the_tags_and_the_same_challenges_as_the_engine():
    cat = load_catalogue(CATALOG_DIR)
    assert tuple(sorted(cat)) == tuple(sorted(RULES["challenges"])) == CHALLENGE_KEYS
    for ck, entry in cat.items():
        t = tags_of(entry)
        assert "2021" in t["owasp"] and t["owasp"].get("2025"), ck  # C11 has no 2021 category (value null)
        assert t["owasp"]["2021"] or ck == "C11", ck
        assert t["cwe"].get("primary"), ck
        assert t["attack"], ck


def test_the_loader_refuses_a_broken_file(tmp_path):
    p = tmp_path / "r.json"
    p.write_text('{"schema_version": "0.1", "challenges": {"C01": {"m1": {"kind": "flag"}}}}', encoding="utf-8")
    with pytest.raises(R.RulesInvalid):
        R.load_rules(p)
