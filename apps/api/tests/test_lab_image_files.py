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


def test_the_runtime_never_imports_yaml():
    for path in (API / "src" / "vulnmart" / "lab").glob("*.py"):
        assert not re.search(r"^\s*(import|from)\s+yaml\b", read(path), re.MULTILINE), path.name


def test_the_milestone_rules_ship_beside_the_code():
    assert (API / "src" / "vulnmart" / "ingest" / "milestone_rules.json").is_file()


def test_no_compose_file_enables_the_runtime_or_the_demo():
    for path in (ROOT / "infra" / "compose").rglob("*.y*ml"):
        text = read(path)
        assert "VULNMART_LAB_RUNTIME" not in text and "VULNMART_LAB_DEMO" not in text, path.name
