import ast
import sys
import tomllib
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]


def test_pyproject_declares_no_dependency():
    data = tomllib.loads((PKG / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["dependencies"] == []
    assert data["project"]["name"] == "vulnmart-attempts"


def test_sources_import_only_standard_library_and_themselves():
    allowed = set(sys.stdlib_module_names) | {"vulnmart_attempts"}
    for path in (PKG / "src" / "vulnmart_attempts").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [(node.module or "").split(".")[0]]
            else:
                continue
            assert set(names) <= allowed, (path.name, names)


def test_no_io_or_system_clock_outside_system_clock():
    forbidden = ("time.sleep", "open(", "threading", "socket", "subprocess", "datetime.now", "utcnow")
    for path in (PKG / "src" / "vulnmart_attempts").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for token in forbidden:
            if token == "datetime.now" and path.name == "clock.py":
                continue
            assert token not in text, (path.name, token)
