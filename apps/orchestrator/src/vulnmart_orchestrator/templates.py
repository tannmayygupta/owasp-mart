"""Templates: JSON files that follow `contracts/instance/instance-template.schema.json`, loaded once at start."""
from __future__ import annotations

import json
from pathlib import Path

import jsonschema


def load_templates(directory: str | Path, schema_path: str | Path) -> dict[str, dict]:
    """Every `*.json` file of `directory`, checked against the schema. Raises on the first invalid file or a repeated id."""
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    out: dict[str, dict] = {}
    for path in sorted(Path(directory).glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
        if errors:
            raise ValueError(f"{path.name} is not a valid template: {errors[0].message}")
        tid = data["template_id"]
        if tid in out:
            raise ValueError(f"template id {tid!r} is defined twice")
        out[tid] = data
    return out
