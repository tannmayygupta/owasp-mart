"""Work package G: the scenario matrix (docs/audit/2026-10-21-scenario-matrix.md) is complete and honest. All 145 ids of the role-scenarios audit have a row, every status is one of
the allowed words, every VERIFIED row names a test and every named test exists in the file named."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MATRIX = (ROOT / "docs" / "audit" / "2026-10-21-scenario-matrix.md").read_text(encoding="utf-8")
SCENARIOS = (ROOT / "docs" / "audit" / "2026-10-21-role-scenarios.md").read_text(encoding="utf-8")
ROW = re.compile(r"^\| ([LCRAX]-\d\d) \| ([a-z-]+) \| ([A-Z-]+) \| (.*?) \| (.*) \|$", re.M)
STATUS = re.compile(r"^(VERIFIED|PARTIAL|EXTERNAL|MISSING-UNOWNED|MISSING-OWNED-BY-[A-F])$")


def rows():
    return {m.group(1): m for m in ROW.finditer(MATRIX)}


def test_every_scenario_of_the_audit_has_exactly_one_row():
    wanted = set(re.findall(r"^\| ([LCRAX]-\d\d) \| ", SCENARIOS, re.M))
    assert len(wanted) == 145
    found = re.findall(r"^\| ([LCRAX]-\d\d) \| ", MATRIX, re.M)
    assert sorted(found) == sorted(wanted), (sorted(set(wanted) - set(found)), sorted(set(found) - set(wanted)))


def test_every_status_is_an_allowed_word_and_a_verified_row_names_a_test():
    for id_, m in rows().items():
        assert STATUS.match(m.group(3)), (id_, m.group(3))
        if m.group(3) == "VERIFIED":
            assert "::test_" in m.group(4), f"{id_} is VERIFIED without a test"


def test_every_named_test_exists():
    for id_, m in rows().items():
        for ref in re.findall(r"`(test_scenarios_[a-z]+\.py)::(test_[a-z0-9_]+)`", m.group(4)):
            text = (Path(__file__).parent / ref[0]).read_text(encoding="utf-8")
            assert re.search(rf"^def {ref[1]}\(", text, re.M), f"{id_}: {ref} does not exist"


def test_the_role_scenarios_audit_points_to_the_matrix_in_every_row():
    for id_ in rows():
        line = re.search(rf"^\| {id_} \| .*$", SCENARIOS, re.M).group(0)
        assert "(matrix: " in line, id_
