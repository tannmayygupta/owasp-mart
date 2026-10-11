"""Alembic history check for the contract rules (story L-07, architecture 07 section 5 and rule 8).

Reads the migration files under <root>/apps/api/migrations/versions with the standard library only (no Alembic needed) and reports:
two or more heads, a duplicate revision id, a missing parent, more than one root, a file that does not parse.
A merge revision (down_revision is a tuple) joins branches: a parent with two children is fine once they are merged; only branches that stay unmerged (two heads) fail.
Files without a evision assignment (for example __init__.py) are ignored.

Usage: python scripts/check_alembic_head.py [--root DIR]
Output: one line "PASS", "FAIL <reason>" per problem, or "NOT-APPLICABLE <reason>" when the folder does not exist yet.
Exit: 0 PASS or NOT-APPLICABLE, 1 FAIL.
"""
from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

VERSIONS = Path("apps/api/migrations/versions")


def _literal(node: ast.AST):
    try:
        return ast.literal_eval(node)
    except (ValueError, SyntaxError):
        return ...


def read_revisions(folder: Path) -> tuple[list[tuple[str, tuple[str, ...], str]], list[str]]:
    """Return ([(revision, parents, file name)], problems) for every .py file in the folder."""
    found: list[tuple[str, tuple[str, ...], str]] = []
    problems: list[str] = []
    for file in sorted(folder.glob("*.py")):
        try:
            tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        except SyntaxError as exc:
            problems.append(f"{file.name}: does not parse (line {exc.lineno}: {exc.msg})")
            continue
        rev: object = ...
        down: object = ...
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name, value = node.targets[0].id, node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
                name, value = node.target.id, node.value
            else:
                continue
            if name == "revision":
                rev = _literal(value)
            elif name == "down_revision":
                down = _literal(value)
        if rev is ...:
            continue  # no revision assignment: not a migration file (for example __init__.py)
        if not isinstance(rev, str) or not rev:
            problems.append(f"{file.name}: `revision` is not a plain string")
            continue
        if down is None:
            parents: tuple[str, ...] = ()
        elif isinstance(down, str):
            parents = (down,)
        elif isinstance(down, (tuple, list)) and all(isinstance(x, str) for x in down):
            parents = tuple(down)
        else:
            problems.append(f"{file.name}: revision {rev} has no readable `down_revision`")
            continue
        found.append((rev, parents, file.name))
    return found, problems


def check(root: Path) -> tuple[str, list[str]]:
    folder = root / VERSIONS
    if not folder.is_dir():
        return "NOT-APPLICABLE", [f"{VERSIONS.as_posix()} does not exist yet"]
    revisions, problems = read_revisions(folder)
    ids: dict[str, str] = {}
    for rev, _, name in revisions:
        if rev in ids:
            problems.append(f"duplicate revision {rev} in {ids[rev]} and {name}")
        ids.setdefault(rev, name)
    children: dict[str, list[str]] = {}
    for rev, parents, name in revisions:
        for parent in parents:
            if parent not in ids:
                problems.append(f"missing parent: revision {rev} ({name}) has down_revision {parent}, which no file defines")
            children.setdefault(parent, []).append(rev)
    heads = sorted(rev for rev in ids if rev not in children)
    if len(heads) > 1:
        problems.append(f"{len(heads)} heads: {', '.join(heads)} (one Alembic history needs one head; add a merge revision or rebase)")
    roots = sorted(rev for rev, parents, _ in revisions if not parents)
    if len(roots) > 1:
        problems.append(f"{len(roots)} root revisions: {', '.join(roots)}")
    if not revisions and not problems:
        problems.append(f"{VERSIONS.as_posix()} exists but holds no revision file")
    return ("FAIL", problems) if problems else ("PASS", [f"one head {heads[0]} in {len(revisions)} revisions"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    status, lines = check(Path(parser.parse_args(argv).root))
    for line in lines:
        print(f"{status} {line}")
    return 1 if status == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
