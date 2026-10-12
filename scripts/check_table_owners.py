"""Table-ownership file check for the contract rules (story L-07, architecture 07 section 5 and rule 8).

Checks <root>/contracts/db/table-owners.yaml against the proposed shape contracts/db/table-owners.schema.json, then:
  - every owner is a module named in .github/CODEOWNERS (path with or without the leading slash) whose folder apps/api/src/vulnmart/<module> exists;
  - no table is listed twice, and no YAML key is repeated.
Each problem names the line of the YAML file.

Usage: python scripts/check_table_owners.py [--root DIR]
Output: "PASS ...", "FAIL <line>: <reason>" per problem, or "NOT-APPLICABLE <reason>" when the file does not exist yet.
Exit: 0 PASS or NOT-APPLICABLE, 1 FAIL.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import yaml
    from jsonschema import Draft202012Validator
except ImportError as exc:  # run it with: uv run --locked --package vulnmart-api python scripts/check_table_owners.py
    print(f"FAIL the packages PyYAML and jsonschema are needed ({exc.name} is missing); run this through uv in the vulnmart-api workspace")
    sys.exit(1)

OWNERS = Path("contracts/db/table-owners.yaml")
SCHEMA = Path("contracts/db/table-owners.schema.json")
CODEOWNERS = Path(".github/CODEOWNERS")
MODULE_LINE = re.compile(r"^/?apps/api/src/vulnmart/([a-z_]+)/?[ \t]")
MODULES_DIR = Path("apps/api/src/vulnmart")


class UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader that rejects a mapping key that appears twice (plain YAML keeps the last one silently)."""

    def construct_mapping(self, node, deep=False):
        seen: set = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            if key in seen:
                raise yaml.constructor.ConstructorError(None, None, f"duplicate key {key!r}", key_node.start_mark)
            seen.add(key)
        return super().construct_mapping(node, deep)


def owner_modules(root: Path) -> tuple[set[str], list[str]]:
    """Modules named in CODEOWNERS whose folder exists; second value lists CODEOWNERS modules without a folder."""
    text = (root / CODEOWNERS).read_text(encoding="utf-8")
    named = {m.group(1) for line in text.splitlines() if (m := MODULE_LINE.match(line))}
    existing = {m for m in named if (root / MODULES_DIR / m).is_dir()}
    return existing, sorted(named - existing)

def node_at(node: yaml.Node, path: list) -> yaml.Node:
    """Follow a JSON path (keys and indexes) in a composed YAML tree; stop at the deepest node that exists."""
    for step in path:
        if isinstance(node, yaml.MappingNode) and isinstance(step, str):
            nxt = next((v for k, v in node.value if k.value == step), None)
        elif isinstance(node, yaml.SequenceNode) and isinstance(step, int) and step < len(node.value):
            nxt = node.value[step]
        else:
            nxt = None
        if nxt is None:
            break
        node = nxt
    return node


def check(root: Path) -> tuple[str, list[str]]:
    file = root / OWNERS
    if not file.is_file():
        return "NOT-APPLICABLE", [f"{OWNERS.as_posix()} does not exist yet"]
    text = file.read_text(encoding="utf-8")
    try:
        tree = yaml.compose(text)
        data = yaml.load(text, Loader=UniqueKeyLoader)  # noqa: S506 (SafeLoader subclass)
    except yaml.YAMLError as exc:
        line = getattr(getattr(exc, "problem_mark", None), "line", 0) + 1
        return "FAIL", [f"line {line}: not valid YAML ({getattr(exc, 'problem', exc)})"]
    if tree is None:
        return "FAIL", ["line 1: the file is empty"]
    schema = json.loads((root / SCHEMA).read_text(encoding="utf-8"))
    problems: list[str] = []
    for err in sorted(Draft202012Validator(schema).iter_errors(data), key=lambda e: list(map(str, e.absolute_path))):
        problems.append(f"line {node_at(tree, list(err.absolute_path)).start_mark.line + 1}: bad shape at /{'/'.join(map(str, err.absolute_path))}: {err.message}")
    if problems:
        return "FAIL", problems
    if not (root / CODEOWNERS).is_file():
        return "FAIL", [f"{CODEOWNERS.as_posix()} does not exist, so the owner modules cannot be checked"]
    modules, folderless = owner_modules(root)
    seen: dict[str, int] = {}
    for i, entry in enumerate(data["tables"]):
        entry_node = node_at(tree, ["tables", i])
        line = node_at(entry_node, ["table"]).start_mark.line + 1
        if entry["owner"] not in modules:
            owner_line = node_at(entry_node, ["owner"]).start_mark.line + 1
            problems.append(f"line {owner_line}: unknown owner module `{entry['owner']}` for table {entry['table']} (modules that are in CODEOWNERS and have a folder: {', '.join(sorted(modules)) or 'none'}{'; in CODEOWNERS without a folder: ' + ', '.join(folderless) if folderless else ''})")
        if entry["table"] in seen:
            problems.append(f"line {line}: duplicate table `{entry['table']}` (first listed on line {seen[entry['table']]})")
        seen.setdefault(entry["table"], line)
    return ("FAIL", problems) if problems else ("PASS", [f"{len(seen)} tables, every owner is a module in CODEOWNERS"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    status, lines = check(Path(parser.parse_args(argv).root))
    for line in lines:
        print(f"{status} {line}")
    return 1 if status == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
