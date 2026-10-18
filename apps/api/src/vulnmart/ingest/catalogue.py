"""Read the challenge catalogue (IF-7, `challenges/catalog/*.yaml`) for tags (FR-DET-01).

Test and CLI helper only: YAML is not a runtime dependency of the API, so `yaml` is imported inside the function. The
production path takes tags from the catalogue-sync tables (owner admin). Read only; nothing here writes the catalogue.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def load_catalogue(directory: Path) -> dict[str, dict[str, Any]]:
    """Challenge key (`C01`..) to the parsed entry, for every `*.yaml` in the directory."""
    import yaml  # dev-only dependency

    out: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("*.yaml")):
        entry = yaml.safe_load(path.read_text(encoding="utf-8"))
        out[str(entry["key"]).upper()] = entry
    return out


def tags_of(entry: dict[str, Any]) -> dict[str, Any]:
    """The framework tags the engine and the report read: OWASP 2021 and 2025, CWE and ATT&CK."""
    return {"owasp": entry.get("owasp", {}), "cwe": entry.get("cwe", {}), "attack": entry.get("attack", [])}
