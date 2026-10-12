"""Check the lab API contract (IF-2) in contracts/api/lab/.

Checks: the OpenAPI 3.1 file is valid; every route is under /api/v1/; the 18 operations exist and no other; every operation
declares its security; the state, access and health values equal those of IF-5; no GET answer schema or valid answer example
can hold a secret-looking name; every valid example matches its schema; every invalid example fails at the path its manifest
names; no real-looking flag is in the contract; the flag result names no oracle reason; every problem example is an IF-8 body (the closed schema, a registered code, its status and title). Run through `pnpm run contracts:check` (last part) or on its own:

    uv run --package vulnmart-api python scripts/check_lab_contract.py [--dir <folder>]

Exit code 0 when every check passes, 1 when any fails, 2 on a usage error.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml
from openapi_spec_validator import validate

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_orchestrator_contract as base  # noqa: E402  (shared helpers, one way to walk a schema)

ROOT = base.ROOT
DEFAULT_DIR = ROOT / "contracts" / "api" / "lab"
IF5_SPEC = ROOT / "contracts" / "orchestrator" / base.SPEC
SPEC = "lab.openapi.yaml"
TEXT = "lab-api.md"

OPERATIONS = {
    ("post", "/api/v1/instances"), ("get", "/api/v1/instances/{instance_id}"),
    ("post", "/api/v1/instances/{instance_id}/open"), ("post", "/api/v1/instances/{instance_id}/reset"),
    ("post", "/api/v1/instances/{instance_id}/stop"),
    ("get", "/api/v1/attempts/{attempt_id}"), ("post", "/api/v1/attempts/{attempt_id}/start"),
    ("post", "/api/v1/attempts/{attempt_id}/submit"), ("post", "/api/v1/attempts/{attempt_id}/flags"),
    ("get", "/api/v1/attempts/{attempt_id}/score"), ("get", "/api/v1/attempts/{attempt_id}/challenges"),
    ("get", "/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints"),
    ("post", "/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints/{level}/unlock"),
    ("get", "/api/v1/attempts/{attempt_id}/evidence"), ("get", "/api/v1/attempts/{attempt_id}/integrity-flags"),
    ("post", "/api/v1/attempts/{attempt_id}/integrity-flags/{integrity_flag_id}/decision"),
    ("get", "/api/v1/attempts/{attempt_id}/report"), ("get", "/api/v1/attempts/{attempt_id}/timeline"),
}
# The names of IF-5 plus what a browser must never learn about the lab host.
SECRET_NAMES = base.SECRET_NAMES | {"host_id", "hostname", "orchestrator_url", "stack", "stack_trace", "traceback", "digest"}
# Enumerations that must be identical to IF-5 (handoff H-78).
SHARED_ENUMS = ("State", "Access", "Health")
# Valid examples whose schema name ends in one of these are requests: a request may carry a `flag`.
REQUEST_SUFFIX = "Request"
NEEDED = {
    "RequestInstanceRequest", "Instance", "OpenTicket", "ConfirmRequest", "Attempt", "FlagSubmissionRequest", "FlagSubmissionResult",
    "Score", "ChallengeProgressList", "HintList", "Hint", "EvidenceList", "IntegrityFlagList", "IntegrityFlag",
    "IntegrityDecisionRequest", "Report", "Timeline", "Problem",
}
METHODS = {"get", "post", "put", "delete", "patch"}
PROBLEM_MEDIA = "application/problem+json"
PROBLEM_TYPE_PREFIX = "urn:vulnmart:error:"
REGISTRY = {c["code"]: c for c in yaml.safe_load((ROOT / "contracts" / "errors" / "error-codes.yaml").read_text(encoding="utf-8"))["codes"]}
# What the submitter of a flag must never be told (the oracle rule): these may not be values of the answer result.
ORACLE_REASONS = {"decoy", "other_instance", "stale_epoch", "wrong"}


def _keys(data):
    """Every object key in a JSON value."""
    if isinstance(data, dict):
        for k, v in data.items():
            yield k
            yield from _keys(v)
    elif isinstance(data, list):
        for item in data:
            yield from _keys(item)


def run(folder: Path, if5_spec: Path = IF5_SPEC) -> tuple[list[str], dict[str, int]]:
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

    found = {(m, p) for p, item in spec["paths"].items() for m in item if m in METHODS}
    counts["operations"] = len(found)
    for missing in sorted(OPERATIONS - found):
        fail(f"missing operation {missing[0].upper()} {missing[1]}")
    for extra in sorted(found - OPERATIONS):
        fail(f"unexpected operation {extra[0].upper()} {extra[1]}")
    for path in spec["paths"]:
        if not path.startswith("/api/v1/"):
            fail(f"path {path} is not under /api/v1/")

    # Security: a session cookie for every operation, and the CSRF header on every POST.
    schemes = spec["components"].get("securitySchemes") or {}
    for need in ("sessionCookie", "csrfHeader"):
        if need not in schemes:
            fail(f"security scheme {need} is missing")
    root_security = spec.get("security") or []
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method not in METHODS:
                continue
            security = op.get("security", root_security)
            names = [set(req) for req in security]
            if not any("sessionCookie" in n for n in names):
                fail(f"{method.upper()} {path} does not require the session cookie")
            if method != "get" and not any({"sessionCookie", "csrfHeader"} <= n for n in names):
                fail(f"{method.upper()} {path} is state-changing but does not require the CSRF header")
            if method == "get" and "requestBody" in op:
                fail(f"GET {path} has a request body")

    # The shared enumerations equal IF-5.
    try:
        if5 = yaml.safe_load(if5_spec.read_text(encoding="utf-8"))["components"]["schemas"]
    except (OSError, yaml.YAMLError, KeyError, TypeError) as exc:
        fail(f"the IF-5 file cannot be read for the enumeration comparison: {exc}")
        if5 = {}
    schemas = spec["components"].get("schemas") or {}
    for name in SHARED_ENUMS:
        ours = (schemas.get(name) or {}).get("enum")
        theirs = (if5.get(name) or {}).get("enum")
        if not ours:
            fail(f"{name} enumeration is missing from the lab file")
        elif not theirs:
            fail(f"{name} enumeration is missing from the IF-5 file")
        elif ours != theirs:
            fail(f"{name} differs from the same enumeration in IF-5")

    # No answer of any operation can carry a secret (response schemas only, never request bodies).
    for path, item in spec["paths"].items():
      for method, op in item.items():
        if method not in METHODS:
            continue
        for status, resp in (op.get("responses") or {}).items():
            if isinstance(resp, dict) and "$ref" in resp:
                resp = base._resolve(spec, resp["$ref"])
            for media, body in (resp.get("content") or {}).items():
                for name in base._walk_properties(spec, (body or {}).get("schema") or {}):
                    if name in SECRET_NAMES:
                        fail(f"{method.upper()} {path} {status} {media}: the answer schema can carry the secret-looking property {name!r}")
                    elif name == base.FREE_FORM:
                        fail(f"{method.upper()} {path} {status} {media}: the answer schema has a free-form object (additionalProperties is not false)")

    # The submitter-facing flag result carries no reason that works as an oracle.
    flag_result = set((schemas.get("FlagResult") or {}).get("enum") or [])
    for reason in sorted(flag_result & ORACLE_REASONS):
        fail(f"FlagResult names the reason {reason!r}, which tells the submitter why a value was not correct (only correct and incorrect are allowed)")

    # Valid examples.
    vdir = folder / "examples" / "valid"
    vman = base._load_manifest(vdir / "manifest.json", "examples/valid/manifest.json", fail, "valid")
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
        data = base._load_json(vdir / name, f"valid/{name}", fail)
        if data is None:
            continue
        for err in base.schema_validator(spec, schema).iter_errors(data):
            fail(f"valid/{name} does not match {schema}: {base.error_path(err)} {err.message}")
        if schema == "Problem" and isinstance(data, dict):  # the parts of a problem that a schema cannot tie together
            if data.get("type") != PROBLEM_TYPE_PREFIX + str(data.get("code")):
                fail(f"valid/{name}: type must be {PROBLEM_TYPE_PREFIX} plus the code")
            info = REGISTRY.get(str(data.get("code")))
            if info is None:
                fail(f"valid/{name}: the code {data.get('code')!r} is not in the error registry (contracts/errors/error-codes.yaml)")
            else:
                if info.get("status") != data.get("status"):
                    fail(f"valid/{name}: status must be the registry's {info.get('status')}")
                if info.get("title") != data.get("title"):
                    fail(f"valid/{name}: title must be the registry's text for the code")
                if str(data.get("code")).startswith("ORCH-"):
                    fail(f"valid/{name}: an ORCH code never reaches a browser")
                if "field" in data or "errors" in data:
                    if data.get("status") != 422:
                        fail(f"valid/{name}: field and errors are for a 422 only")
                    if "field" in data and "errors" in data:
                        fail(f"valid/{name}: field and errors are never both present")
        if not schema.endswith(REQUEST_SUFFIX):  # an answer example must not hold a secret-looking name
            for key in sorted(set(_keys(data)) & SECRET_NAMES):
                fail(f"valid/{name} is an answer example but holds the secret-looking name {key!r}")
    for name in vman:
        if name not in vfiles:
            fail(f"valid manifest names {name}, which does not exist")
    for schema in sorted(NEEDED - set(vman.values())):
        fail(f"no valid example for {schema}")
    results = {p.name for p in vdir.glob("flags.result.*.json")}
    seen = set()
    for name in results:
        data = base._load_json(vdir / name, f"valid/{name}", fail)
        if isinstance(data, dict):
            seen.add(data.get("result"))
    for result in ("correct", "incorrect"):
        if result not in seen:
            fail(f"no valid example of the flag result {result}")

    # Invalid examples.
    idir = folder / "examples" / "invalid"
    iman = base._load_manifest(idir / "manifest.json", "examples/invalid/manifest.json", fail, "invalid")
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
        data = base._load_json(idir / name, f"invalid/{name}", fail)
        if data is None:
            continue
        paths = [base.error_path(e) for e in base.schema_validator(spec, entry["schema"]).iter_errors(data)]
        if not paths:
            fail(f"invalid/{name} passed {entry['schema']} but must fail")
        elif entry["path"] not in paths:
            fail(f"invalid/{name} failed at {paths} but the manifest says {entry['path']}")
    for name in iman:
        if name not in ifiles:
            fail(f"invalid manifest names {name}, which does not exist")

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
    for p in [spec_path, text_path, *vdir.glob("*.json"), *idir.glob("*.json")]:
        if not p.is_file():
            continue
        try:
            content = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            fail(f"{p.name} cannot be read as text: {exc}")
            continue
        for m in base.FLAG_LIKE.finditer(content):
            if not base.FAKE_FLAG.match(m.group(0)):
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
    print(f"lab contract: checked {counts['operations']} operations, {counts['valid']} valid and {counts['invalid']} invalid examples")
    print("lab contract: " + ("FAIL" if errors else "PASS"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
