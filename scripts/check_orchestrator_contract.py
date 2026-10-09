"""Check the orchestrator contract (IF-5) in contracts/orchestrator/.

Checks: the OpenAPI 3.1 file is valid; the seven calls and the state report exist; every valid example
matches its schema; every invalid example fails at the path its manifest names; no GET answer schema can
hold a secret; the signing vector reproduces; no real-looking flag is in the contract. Run through
`pnpm run contracts:check` (after the instance contract check) or on its own:

    uv run --package vulnmart-api python scripts/check_orchestrator_contract.py [--dir <folder>]

Exit code 0 when every check passes, 1 when any fails, 2 on a usage error.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "contracts" / "orchestrator"
SPEC = "orchestrator.openapi.yaml"
TEXT = "orchestrator-api.md"

OPERATIONS = {
    ("post", "/v1/instances"), ("get", "/v1/instances"), ("get", "/v1/instances/{instance_id}"),
    ("post", "/v1/instances/{instance_id}/reset"), ("post", "/v1/instances/{instance_id}/access"),
    ("post", "/v1/instances/{instance_id}/destroy"), ("get", "/v1/host"), ("post", "/internal/v1/orch/state"),
}
SECRET_NAMES = {"flags", "flag", "decoys", "decoy", "flag_digests", "sha256", "seed", "event_key", "value", "owner_hash", "first_seq"}
FREE_FORM = "<free-form object>"
FAKE_FLAG = re.compile(r"^VM\{([A-Z2-7])\1{23}\}$")
FLAG_LIKE = re.compile(r"VM\{[A-Z2-7]{24}\}")


def _esc(s: str) -> str:
    return str(s).replace("~", "~0").replace("/", "~1")


def error_path(err) -> str:
    parts = list(err.absolute_path)
    if err.validator == "required":
        m = re.match(r"'(.*)' is a required property", err.message)
        if m:
            parts.append(m.group(1))
    elif err.validator == "additionalProperties":
        m = re.search(r"\('(.*?)' (?:was|were) unexpected", err.message)
        if m:
            parts.append(m.group(1))
    return "".join("/" + _esc(p) for p in parts)


def schema_validator(spec: dict, name: str) -> Draft202012Validator:
    # The OpenAPI 3.1 schema dialect is JSON Schema 2020-12; $refs point into this same document.
    return Draft202012Validator({"$ref": f"#/components/schemas/{name}", "components": spec["components"]})


def _resolve(spec: dict, ref: str):
    node = spec
    for part in ref.lstrip("#/").split("/"):
        node = node[part.replace("~1", "/").replace("~0", "~")]
    return node


def _walk_properties(spec: dict, schema, seen=None):
    """Yield every property name reachable from a schema (follows local $refs), and the marker
    '<free-form object>' for an object schema that is not closed (additionalProperties is not false)."""
    seen = seen if seen is not None else set()
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if ref:
            if ref in seen:
                return
            seen.add(ref)
            yield from _walk_properties(spec, _resolve(spec, ref), seen)
        typ = schema.get("type")
        is_object = typ == "object" or (isinstance(typ, list) and "object" in typ)
        if is_object and schema.get("additionalProperties") is not False:
            yield FREE_FORM
        for key, value in schema.items():
            if key == "properties":
                for pname, sub in value.items():
                    yield pname
                    yield from _walk_properties(spec, sub, seen)
            elif key != "$ref":
                yield from _walk_properties(spec, value, seen)
    elif isinstance(schema, list):
        for item in schema:
            yield from _walk_properties(spec, item, seen)


def _load_json(path: Path, label: str, fail):
    """Read a JSON file; on any problem report it by name and return None (never a traceback)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"{label} cannot be read as JSON: {exc}")
        return None


def _load_manifest(path: Path, label: str, fail, kind: str):
    """A manifest is a JSON object. Valid: {file: schema name}. Invalid: {file: {schema, path, rule}}."""
    if not path.is_file():
        return {}
    data = _load_json(path, label, fail)
    if data is None:
        return {}
    if not isinstance(data, dict):
        fail(f"{label} must be a JSON object")
        return {}
    good = {}
    for name, entry in data.items():
        if kind == "valid":
            ok = isinstance(entry, str)
        else:
            ok = isinstance(entry, dict) and isinstance(entry.get("schema"), str) and isinstance(entry.get("path"), str)
        if ok:
            good[name] = entry
        else:
            fail(f"{label}: the entry for {name} is malformed")
    return good


def run(folder: Path) -> tuple[list[str], dict[str, int]]:
    errors: list[str] = []
    counts = {"operations": 0, "valid": 0, "invalid": 0}

    def fail(msg: str) -> None:
        errors.append(msg)

    spec_path = folder / SPEC
    if not spec_path.is_file():
        return [f"{SPEC} is missing"], counts
    try:
        spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        return [f"{SPEC} cannot be read as YAML: {exc}"], counts
    if not isinstance(spec, dict) or not isinstance(spec.get("paths"), dict) or not isinstance(spec.get("components"), dict):
        return [f"{SPEC} is not an OpenAPI document (no paths or components)"], counts
    try:
        validate(spec)
    except Exception as exc:  # the validator raises several error types
        return [f"{SPEC} is not valid OpenAPI: {exc}"], counts
    if not str(spec.get("openapi", "")).startswith("3.1"):
        fail("the file must be OpenAPI 3.1")

    found = {(m, p) for p, item in spec["paths"].items() for m in item if m in {"get", "post", "put", "delete", "patch"}}
    counts["operations"] = len(found)
    for missing in sorted(OPERATIONS - found):
        fail(f"missing operation {missing[0].upper()} {missing[1]}")
    for extra in sorted(found - OPERATIONS):
        fail(f"unexpected operation {extra[0].upper()} {extra[1]}")

    # Every GET answer must be unable to carry a secret.
    for path, item in spec["paths"].items():
        op = item.get("get")
        if not op:
            continue
        for status, resp in op["responses"].items():
            if isinstance(resp, dict) and "$ref" in resp:  # components/responses/...
                resp = _resolve(spec, resp["$ref"])
            # every media type, application/problem+json included
            for media, body in (resp.get("content") or {}).items():
                for name in _walk_properties(spec, (body or {}).get("schema") or {}):
                    if name in SECRET_NAMES:
                        fail(f"GET {path} {status} {media}: the answer schema can carry the secret-looking property {name!r}")
                    elif name == FREE_FORM:
                        fail(f"GET {path} {status} {media}: the answer schema has a free-form object (additionalProperties is not false)")

    # Valid examples.
    vdir = folder / "examples" / "valid"
    schemas = spec["components"].get("schemas") or {}
    vman = _load_manifest(vdir / "manifest.json", "examples/valid/manifest.json", fail, "valid")
    vfiles = sorted(p.name for p in vdir.glob("*.json") if p.name != "manifest.json")
    if not vfiles:
        fail("no valid examples")
    for name in vfiles:
        schema = vman.get(name)
        if schema is None:
            fail(f"valid/{name} is not in the valid manifest")
            continue
        if schema not in schemas:
            fail(f"valid/{name}: the manifest names the schema {schema}, which does not exist")
            continue
        counts["valid"] += 1
        data = _load_json(vdir / name, f"valid/{name}", fail)
        if data is None:
            continue
        for err in schema_validator(spec, schema).iter_errors(data):
            fail(f"valid/{name} does not match {schema}: {error_path(err)} {err.message}")
    for name in vman:
        if name not in vfiles:
            fail(f"valid manifest names {name}, which does not exist")
    needed = {"CreateInstanceRequest", "InstanceStatus", "ResetInstanceRequest", "AccessRequest", "InstancePage", "HostStatus", "StateReport", "Problem"}
    for schema in sorted(needed - set(vman.values())):
        fail(f"no valid example for {schema}")

    # Invalid examples.
    idir = folder / "examples" / "invalid"
    iman = _load_manifest(idir / "manifest.json", "examples/invalid/manifest.json", fail, "invalid")
    ifiles = sorted(p.name for p in idir.glob("*.json") if p.name != "manifest.json")
    for name in ifiles:
        entry = iman.get(name)
        if entry is None:
            fail(f"invalid/{name} is not in the invalid manifest")
            continue
        if entry["schema"] not in schemas:
            fail(f"invalid/{name}: the manifest names the schema {entry['schema']}, which does not exist")
            continue
        counts["invalid"] += 1
        data = _load_json(idir / name, f"invalid/{name}", fail)
        if data is None:
            continue
        paths = [error_path(e) for e in schema_validator(spec, entry["schema"]).iter_errors(data)]
        if not paths:
            fail(f"invalid/{name} passed {entry['schema']} but must fail")
        elif entry["path"] not in paths:
            fail(f"invalid/{name} failed at {paths} but the manifest says {entry['path']}")
    for name in iman:
        if name not in ifiles:
            fail(f"invalid manifest names {name}, which does not exist")

    # Signing vector.
    vec_path = folder / "examples" / "signing-vector.json"
    if not vec_path.is_file():
        fail("examples/signing-vector.json is missing")
    else:
        vec = _load_json(vec_path, "examples/signing-vector.json", fail)
        keys = ["key", "method", "target", "timestamp", "nonce", "body", "body_sha256", "signing_string", "signature"]
        if vec is not None:
            missing = [k for k in keys if not isinstance(vec, dict) or not isinstance(vec.get(k), str)]
            if missing:
                fail(f"examples/signing-vector.json lacks (or has a non-text value for) {', '.join(missing)}")
            else:
                sha = hashlib.sha256(vec["body"].encode()).hexdigest()
                string = "\n".join(["v1", vec["method"], vec["target"], vec["timestamp"], vec["nonce"], sha])
                sig = "v1=" + hmac.new(vec["key"].encode(), string.encode(), hashlib.sha256).hexdigest()
                if sha != vec["body_sha256"] or string != vec["signing_string"] or sig != vec["signature"]:
                    fail("examples/signing-vector.json does not reproduce")

    # The text and the no-real-flag rule.
    text_path = folder / TEXT
    if not text_path.is_file():
        fail(f"{TEXT} is missing")
    else:
        text = text_path.read_text(encoding="utf-8")
        if "## Open points (to confirm)" not in text:
            fail(f"{TEXT} has no 'Open points (to confirm)' table")
        if not re.search(r"^\| \d+ \|", text, re.M):
            fail(f"{TEXT} open-points table has no rows")
    for p in [spec_path, text_path, *vdir.glob("*.json"), *idir.glob("*.json"), vec_path]:
        if not p.is_file():
            continue
        try:
            content = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            fail(f"{p.name} cannot be read as text: {exc}")
            continue
        for m in FLAG_LIKE.finditer(content):
            if not FAKE_FLAG.match(m.group(0)):
                fail(f"{p.name} holds a real-looking flag; use an obviously fake one (one repeated letter)")
    return errors, counts


def main(argv: list[str]) -> int:
    folder = DEFAULT_DIR
    args = list(argv)
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0
    if args:
        if args[0] == "--dir" and len(args) == 2:
            folder = Path(args[1])
        else:
            print(f"Unknown argument: {' '.join(args)}", file=sys.stderr)
            return 2
    try:
        errors, counts = run(folder)
    except Exception as exc:  # a malformed contract must give a FAIL line, never a traceback
        errors, counts = [f"the check could not finish: {type(exc).__name__}: {exc}"], {"operations": 0, "valid": 0, "invalid": 0}
    for e in errors:
        print("FAIL " + e, file=sys.stderr)
    print(f"orchestrator contract: checked {counts['operations']} operations, {counts['valid']} valid and {counts['invalid']} invalid examples")
    print("orchestrator contract: " + ("FAIL" if errors else "PASS"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
