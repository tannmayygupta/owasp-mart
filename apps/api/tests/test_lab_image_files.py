"""Story 8.1: the image files carry what the runtime needs, the runtime never imports yaml, and no deployed profile enables the demo."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API = ROOT / "apps" / "api"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_dockerfile_copies_the_attempts_package_and_the_event_schema():
    text = read(API / "Dockerfile")
    assert "COPY packages/py-attempts/pyproject.toml packages/py-attempts/pyproject.toml" in text
    assert "COPY packages/py-attempts/src packages/py-attempts/src" in text
    assert "COPY contracts/events/instance-events.schema.json /app/contracts/events/instance-events.schema.json" in text
    assert "VULNMART_EVENT_SCHEMA=/app/contracts/events/instance-events.schema.json" in text


def test_dockerignore_allows_the_new_paths():
    text = read(API / "Dockerfile.dockerignore")
    for line in ("!packages/py-attempts/pyproject.toml", "!packages/py-attempts/src/**", "!contracts/events/instance-events.schema.json"):
        assert line in text.splitlines()


def test_the_manifest_lists_the_runtime_dependencies():
    text = read(API / "pyproject.toml")
    runtime = text.split("[dependency-groups]")[0]
    assert '"vulnmart-attempts"' in runtime and '"jsonschema==4.26.0"' in runtime
    assert "vulnmart-attempts = { workspace = true }" in text


def test_the_event_schema_the_image_copies_exists():
    assert (ROOT / "contracts" / "events" / "instance-events.schema.json").is_file()


def test_only_the_catalogue_reader_imports_yaml_and_only_with_safe_load():
    # PyYAML is a runtime dependency since the lab serves the catalogue (IF-7 files are YAML); nothing else of the runtime needs it
    for path in (API / "src" / "vulnmart" / "lab").glob("*.py"):
        uses = re.search(r"^\s*(import|from)\s+yaml\b", read(path), re.MULTILINE)
        assert (uses is None) == (path.name != "catalog.py"), path.name
    text = read(API / "src" / "vulnmart" / "lab" / "catalog.py")
    assert "yaml.safe_load(" in text and "yaml.load(" not in text
    assert '"pyyaml==6.0.3"' in read(API / "pyproject.toml").split("[dependency-groups]")[0]


def test_the_milestone_rules_ship_beside_the_code():
    assert (API / "src" / "vulnmart" / "ingest" / "milestone_rules.json").is_file()


def test_no_compose_file_enables_the_runtime_or_the_demo():
    for path in (ROOT / "infra" / "compose").rglob("*.y*ml"):
        text = read(path)
        assert "VULNMART_LAB_RUNTIME" not in text and "VULNMART_LAB_DEMO" not in text, path.name
