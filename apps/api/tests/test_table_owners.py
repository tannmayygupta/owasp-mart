"""The table-owners file (IF-10): it passes stream L's check, lists every table of architecture 04 once, and every owner
is a module folder of the API."""
from __future__ import annotations

import re
import shutil
import subprocess
import sys

import yaml

from support import ROOT

OWNERS = yaml.safe_load((ROOT / "contracts" / "db" / "table-owners.yaml").read_text(encoding="utf-8"))
ARCH_04 = (ROOT / "docs" / "architecture" / "04-data-and-state.md").read_text(encoding="utf-8")


def architecture_tables() -> set[str]:
    """The tables of sections 2.1 to 2.8: the first cell of every table row in those sections."""
    body = ARCH_04.split("### 2.1", 1)[1].split("## 3.", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", body, re.MULTILINE))


def test_the_check_of_stream_l_passes():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_table_owners.py"), "--root", str(ROOT)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("PASS")


def run_check_on(tmp_path, tables: list[dict]) -> subprocess.CompletedProcess:
    """The check of stream L on a copy of the repository files it reads, with another table list."""
    for rel in (".github/CODEOWNERS", "contracts/db/table-owners.schema.json"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, tmp_path / rel)
    for d in (ROOT / "apps" / "api" / "src" / "vulnmart").iterdir():
        if d.is_dir():
            (tmp_path / "apps" / "api" / "src" / "vulnmart" / d.name).mkdir(parents=True, exist_ok=True)
    (tmp_path / "contracts" / "db" / "table-owners.yaml").write_text(yaml.safe_dump({"version": 1, "tables": tables}), encoding="utf-8")
    return subprocess.run([sys.executable, str(ROOT / "scripts" / "check_table_owners.py"), "--root", str(tmp_path)], capture_output=True, text=True)


def test_a_duplicate_table_or_an_unknown_owner_fails_the_check(tmp_path):
    assert run_check_on(tmp_path, OWNERS["tables"]).returncode == 0, "the copy passes as the real file does"
    dup = run_check_on(tmp_path, [*OWNERS["tables"], {"table": "users", "owner": "orgs"}])
    assert dup.returncode == 1 and "users" in dup.stdout
    unknown = run_check_on(tmp_path, [{"table": "users", "owner": "billing"}])
    assert unknown.returncode == 1 and "billing" in unknown.stdout


def test_every_table_of_architecture_04_is_listed_once_and_nothing_else_except_the_keystore():
    listed = [t["table"] for t in OWNERS["tables"]]
    assert len(listed) == len(set(listed))
    arch = architecture_tables()
    assert len(arch) >= 40, "the parser found the architecture tables"
    assert arch - set(listed) == set(), "a table of the architecture has no owner"
    assert set(listed) - arch == {"deks"}, "only the keystore table is outside sections 2.1 to 2.8"


def test_every_owner_is_a_module_package():
    for owner in {t["owner"] for t in OWNERS["tables"]}:
        assert (ROOT / "apps" / "api" / "src" / "vulnmart" / owner / "__init__.py").is_file(), owner


def test_stream_l_tables_belong_to_stream_l_modules():
    lab_modules = {"attempts", "instances", "scoring", "ingest", "flags"}
    lab_tables = {"attempts", "instance_hosts", "instances", "instance_transitions", "instance_epochs", "events", "milestones",
                  "flag_submissions", "hint_unlocks", "evidence", "integrity_flags", "score_snapshots", "activity_buckets",
                  "held_captures", "review_audit", "attempt_events", "bot_visits", "security_events", "challenge_opens"}
    for row in OWNERS["tables"]:
        assert (row["table"] in lab_tables) == (row["owner"] in lab_modules), row
