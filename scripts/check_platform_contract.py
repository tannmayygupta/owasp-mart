"""Checks the platform API contract (IF-1) and the bundle of the browser API fragments (story P-04).

Fragment checks (contracts/api/platform/platform.openapi.yaml):
  - valid OpenAPI 3.1; every operation has an unique operationId, tags, a success answer; every answer has the Cache-Control
    constant private, no-store;
  - the auth rules: an authenticated route needs the session cookie, an authenticated state-changing route also the
    CSRF header, a public state-changing route declares the Origin answer (403) and the rate-limit answer (429), and so does
    an authenticated one that takes a body (it checks a secret or writes);
  - no internal route (handoffs H-16, H-17); every path is under /api/v1/;
  - the Problem schema equals the IF-8 body schema; every error answer uses it with application/problem+json;
  - every example validates against its schema; every error example uses a code of the IF-8 registry with its
    status, title and type; the live stream example frames carry IF-3 events that validate;
  - the request examples (examples/valid) pass and each invalid one (examples/invalid) fails at its path.
Bundle checks (contracts/api/bundle/openapi.json): valid OpenAPI 3.1, every reference resolves, every operation of
both fragments is there once and carries x-fragment, the report lists what was renamed.
Usage: python scripts/check_platform_contract.py [--platform FILE] [--lab FILE] [--bundle FILE] [--report FILE]
                                                 [--errors FILE] [--problem FILE] [--events FILE] [--examples DIR]
Exit code 0 when every check passes, 1 when any fails, 2 on a usage error.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate as validate_openapi
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = ROOT / "contracts" / "api" / "platform" / "platform.openapi.yaml"
LAB = ROOT / "contracts" / "api" / "lab" / "lab.openapi.yaml"
BUNDLE = ROOT / "contracts" / "api" / "bundle" / "openapi.json"
REPORT = ROOT / "contracts" / "api" / "bundle" / "bundle-report.json"
ERRORS = ROOT / "contracts" / "errors" / "error-codes.yaml"
PROBLEM = ROOT / "contracts" / "errors" / "problem.schema.json"
EVENTS = ROOT / "contracts" / "domain-events" / "domain-events.schema.json"
EXAMPLES = ROOT / "contracts" / "api" / "platform" / "examples"

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
CHANGING = ("post", "put", "patch", "delete")
COSMETIC = {"description", "summary", "title", "example", "examples"}
NAME_MAPS = {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}
# The one error status that is not an IF-8 body: a probe reads `{"status": "degraded"}` from the health route (see its description).
NOT_PROBLEMS = {("/api/v1/health", "503")}
INTERNAL = re.compile(r"(^|/)internal(/|$)", re.IGNORECASE)
DOC_URI = "urn:vulnmart:doc"
JSON_TYPES = ("application/json", "application/problem+json")


def first_line(e: Exception) -> str:
    """The first line of a validator's message; some of its exceptions carry no text, then the type name is the message."""
    lines = str(e).splitlines()
    return lines[0] if lines else type(e).__name__


def load(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    return json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)


def operations(doc: dict) -> list[tuple[str, str, dict]]:
    return [(p, m, item[m]) for p, item in doc.get("paths", {}).items() for m in METHODS if m in item]


def resolve(doc: dict, node: Any) -> Any:
    """Follow local `#/components/...` references."""
    seen = 0
    while isinstance(node, dict) and "$ref" in node and seen < 20:
        ref = node["$ref"]
        if not ref.startswith("#/"):
            return node
        cur: Any = doc
        for part in ref[2:].split("/"):
            cur = cur[part.replace("~1", "/").replace("~0", "~")]
        node = cur
        seen += 1
    return node


def validator_for(doc: dict, schema: Any) -> Draft202012Validator:
    resource = Resource.from_contents(doc, default_specification=DRAFT202012)
    registry = Registry().with_resource(DOC_URI, resource)
    # A schema written inside the document refers to `#/components/...`: wrap it so the references resolve against the document.
    wrapped = {"$ref": f"{DOC_URI}#/components/schemas/{schema['$ref'].rsplit('/', 1)[1]}"} if isinstance(schema, dict) and "$ref" in schema else schema
    if wrapped is schema:
        # inline schema: resolve its references through the document resource
        wrapped = _rebase(schema)
    return Draft202012Validator(wrapped, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)


def _rebase(node: Any) -> Any:
    """Point every local reference of an inline schema at the document resource."""
    if isinstance(node, dict):
        return {k: (f"{DOC_URI}{v}" if k == "$ref" and isinstance(v, str) and v.startswith("#/") else _rebase(v)) for k, v in node.items()}
    if isinstance(node, list):
        return [_rebase(x) for x in node]
    return node


def same(a: Any, b: Any, named: bool = False) -> bool:
    """Deep equality ignoring descriptions, titles and examples. `named` is true for a map of member names (the value of `properties`),
    where a member may itself be called `title` or `description` and must be compared."""
    if isinstance(a, dict) and isinstance(b, dict):
        ka = set(a) if named else {k for k in a if k not in COSMETIC}
        kb = set(b) if named else {k for k in b if k not in COSMETIC}
        return ka == kb and all(same(a[k], b[k], not named and k in NAME_MAPS) for k in ka)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def error_path(err: Any) -> str:
    parts = [str(p).replace("~", "~0").replace("/", "~1") for p in err.absolute_path]
    path = "".join("/" + p for p in parts)
    if err.validator == "required":
        m = re.search(r"'([^']+)' is a required property", err.message)
        if m:
            path += "/" + m.group(1)
    elif err.validator == "additionalProperties":
        m = re.search(r"\('([^']+)'", err.message)
        if m:
            path += "/" + m.group(1)
    return path


def collect_examples(doc: dict, media: dict) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    if "example" in media:
        out.append(("example", media["example"]))
    for name, ex in (media.get("examples") or {}).items():
        ex = resolve(doc, ex)
        if "value" in ex:
            out.append((name, ex["value"]))
    return out


def check_fragment(doc: dict, *, codes: dict[str, dict], problem_schema: dict, events_schema: dict | None, examples_dir: Path | None) -> list[str]:
    problems: list[str] = []
    fail = problems.append
    try:
        validate_openapi(doc)
    except Exception as e:  # noqa: BLE001 - any validator failure is a problem
        return [f"not a valid OpenAPI 3.1 document: {first_line(e)}"]

    ids: dict[str, str] = {}
    for path, method, op in operations(doc):
        where = f"{method.upper()} {path}"
        if not path.startswith("/api/v1/"):
            fail(f"{where}: not under /api/v1/")
        if INTERNAL.search(path):
            fail(f"{where}: an internal route is never in a browser fragment (H-16, H-17)")
        oid = op.get("operationId")
        if not oid:
            fail(f"{where}: no operationId")
        elif oid in ids:
            fail(f"{where}: operationId {oid} is also used by {ids[oid]}")
        else:
            ids[oid] = where
        if not op.get("tags"):
            fail(f"{where}: no tags")
        security = op.get("security", doc.get("security", []))
        names = {n for req in security for n in req}
        public = not security
        if not public and "sessionCookie" not in names:
            fail(f"{where}: an authenticated route needs the session cookie")
        if method in CHANGING and not public and "csrfHeader" not in names:
            fail(f"{where}: an authenticated state-changing route needs the CSRF header")
        if method in CHANGING and public:
            for status in ("403", "429"):
                if status not in op["responses"]:
                    fail(f"{where}: a public state-changing route declares {status} (Origin check, rate limit)")
        if method in CHANGING and not public and "requestBody" in op and "429" not in op["responses"]:
            fail(f"{where}: an authenticated state-changing route with a body declares 429 (it checks a secret or writes, so it is rate limited)")
        successes = [s for s in op["responses"] if s.startswith("2")]
        if not successes:
            fail(f"{where}: no success answer")
        for status, resp in op["responses"].items():
            r = resolve(doc, resp)
            headers = r.get("headers") or {}
            if "Cache-Control" not in headers:
                fail(f"{where} {status}: no Cache-Control header (every answer is private, no-store)")
            else:
                value = (resolve(doc, headers["Cache-Control"]).get("schema") or {}).get("const")
                if value != "private, no-store":
                    fail(f"{where} {status}: the Cache-Control header must be the constant private, no-store (it is {value!r})")
            if status.startswith(("4", "5")) and "application/problem+json" not in (r.get("content") or {}) and (path, status) not in NOT_PROBLEMS:
                fail(f"{where} {status}: an error answer is application/problem+json")
            for ctype, media in (r.get("content") or {}).items():
                if status.startswith(("4", "5")) and ctype == "application/problem+json":
                    schema = media.get("schema", {})
                    if schema.get("$ref") != "#/components/schemas/Problem":
                        fail(f"{where} {status}: an error answer uses the Problem schema")
                if not collect_examples(doc, media):
                    fail(f"{where} {status} {ctype}: no example")
        body = resolve(doc, op.get("requestBody", {}))
        for ctype in (body.get("content") or {}):
            if ctype != "application/json":
                fail(f"{where}: a request body is JSON only")

    # the Problem schema is the IF-8 body
    mine = doc.get("components", {}).get("schemas", {}).get("Problem")
    if mine is None:
        fail("components.schemas.Problem is missing")
    else:
        theirs = {k: v for k, v in problem_schema.items() if k not in ("$schema", "$id")}
        if not same(mine, theirs):
            fail("components.schemas.Problem differs from contracts/errors/problem.schema.json (IF-8)")

    # examples validate; error examples follow the registry
    for path, method, op in operations(doc):
        where = f"{method.upper()} {path}"
        for status, resp in op["responses"].items():
            r = resolve(doc, resp)
            for ctype, media in (r.get("content") or {}).items():
                schema = media.get("schema")
                for name, value in collect_examples(doc, media):
                    if ctype == "text/event-stream":
                        problems.extend(f"{where} {status} stream example: {m}" for m in check_stream(value, events_schema))
                        continue
                    if schema is None:
                        continue
                    errs = sorted(validator_for(doc, schema).iter_errors(value), key=lambda e: list(e.absolute_path))
                    for e in errs[:3]:
                        fail(f"{where} {status} example {name} {error_path(e) or '(root)'}: {e.message[:120]}")
                    if ctype == "application/problem+json" and not errs:
                        # a range or default key ("4XX", "default") has no single status to compare with
                        problems.extend(f"{where} {status} example {name}: {m}" for m in check_problem_example(value, int(status) if status.isdigit() else None, codes))
    if examples_dir is not None:
        problems.extend(check_request_examples(doc, examples_dir))
    return problems


def check_problem_example(body: dict, status: int | None, codes: dict[str, dict]) -> list[str]:
    out = []
    entry = codes.get(body.get("code"))
    if entry is None:
        return [f"code {body.get('code')} is not in the error registry (IF-8)"]
    if body.get("status") != entry["status"] or (status is not None and body.get("status") != status):
        out.append(f"status {body.get('status')} must be {entry['status']} for {body['code']} and the answer's {status}")
    if body.get("title") != entry["title"]:
        out.append("title must equal the registry title")
    if body.get("type") != f"urn:vulnmart:error:{body['code']}":
        out.append("type must be urn:vulnmart:error: plus the code")
    return out


def check_stream(text: str, events_schema: dict | None) -> list[str]:
    out = []
    frames = [f for f in text.strip("\n").split("\n\n") if f.strip() and not f.startswith(":")]
    if not frames:
        return ["no frame"]
    validator = Draft202012Validator(events_schema, format_checker=Draft202012Validator.FORMAT_CHECKER) if events_schema else None
    for frame in frames:
        fields: dict[str, str] = {}
        for line in frame.split("\n"):
            k, _, v = line.partition(":")
            v = v[1:] if v.startswith(" ") else v  # one space after the colon is dropped (the SSE rule)
            fields[k] = fields[k] + "\n" + v if k == "data" and k in fields else v
        if not re.fullmatch(r"\d{1,15}-\d{1,9}", fields.get("id", "")):
            out.append("a frame has no stream id")
        try:
            event = json.loads(fields.get("data", ""))
        except json.JSONDecodeError:
            out.append("a frame's data is not JSON")
            continue
        if not isinstance(event, dict):
            out.append("a frame's data is not a JSON object")
            continue
        if fields.get("event") != event.get("type"):
            out.append("the SSE event name is not the event type")
        if validator is not None:
            out.extend(f"IF-3 {error_path(e) or '(root)'}: {e.message[:100]}" for e in validator.iter_errors(event))
    return out


def check_request_examples(doc: dict, examples_dir: Path) -> list[str]:
    problems: list[str] = []
    for kind in ("valid", "invalid"):
        folder = examples_dir / kind
        files = sorted(p for p in folder.glob("*.json")) if folder.exists() else []
        if kind == "valid" and not files:
            problems.append("examples/valid has no request example")
        for f in files:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except ValueError as e:
                problems.append(f"examples/{kind}/{f.name}: not valid JSON ({e})")
                continue
            if not isinstance(data, dict) or "body" not in data:
                problems.append(f"examples/{kind}/{f.name}: needs the members schema and body")
                continue
            schema_name = data.get("schema")
            if schema_name not in doc.get("components", {}).get("schemas", {}):
                problems.append(f"examples/{kind}/{f.name}: no schema {schema_name}")
                continue
            errs = list(validator_for(doc, {"$ref": f"#/components/schemas/{schema_name}"}).iter_errors(data["body"]))
            if kind == "valid" and errs:
                problems.append(f"examples/valid/{f.name}: {error_path(errs[0]) or '(root)'}: {errs[0].message[:100]}")
            if kind == "invalid":
                if not errs:
                    problems.append(f"examples/invalid/{f.name}: should fail {data.get('path')} but passes")
                elif data.get("path") not in {error_path(e) for e in errs}:
                    problems.append(f"examples/invalid/{f.name}: should fail at {data.get('path')} but fails at {sorted({error_path(e) for e in errs})}")
    return problems


def check_bundle(bundle: dict, report: dict, platform: dict, lab: dict) -> list[str]:
    problems: list[str] = []
    fail = problems.append
    try:
        validate_openapi(bundle)
    except Exception as e:  # noqa: BLE001
        return [f"the bundle is not a valid OpenAPI 3.1 document: {first_line(e)}"]
    ops = operations(bundle)
    want = len(operations(platform)) + len(operations(lab))
    if len(ops) != want:
        fail(f"the bundle has {len(ops)} operations; the fragments have {want}")
    expected = {(p, m, o.get("operationId"), name) for name, doc in (("platform", platform), ("lab", lab)) for p, m, o in operations(doc)}
    found = {(p, m, o.get("operationId"), o.get("x-fragment")) for p, m, o in ops}
    for p, m, oid, name in sorted(expected - found, key=str):
        fail(f"{m.upper()} {p} ({oid}) of the {name} fragment is not in the bundle with x-fragment {name}")
    for p, m, oid, name in sorted(found - expected, key=str):
        fail(f"{m.upper()} {p} ({oid}, x-fragment {name}) is in the bundle but not in the fragment")
    ids = [op.get("operationId") for _, _, op in ops]
    if len(set(ids)) != len(ids):
        fail("an operationId is repeated in the bundle")
    for path, method, op in ops:
        if op.get("x-fragment") not in ("platform", "lab"):
            fail(f"{method.upper()} {path}: no x-fragment")
        if INTERNAL.search(path):
            fail(f"{path}: an internal route is in the browser bundle")
    renamed = {r["renamed_to"] for r in report.get("renamed_components", [])}
    for section, items in bundle.get("components", {}).items():
        for name in items:
            if name.startswith("Lab") and name not in renamed:
                fail(f"components.{section}.{name} has the Lab prefix but is not in the report")
    for r in report.get("renamed_components", []):
        if r["renamed_to"] not in bundle["components"].get(r["section"], {}):
            fail(f"the report renames {r['name']} to {r['renamed_to']}, which is not in the bundle")
    if report.get("operations") != len(ops):
        fail("the report's operation count differs from the bundle")
    return problems


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    opts = {"platform": PLATFORM, "lab": LAB, "bundle": BUNDLE, "report": REPORT, "errors": ERRORS, "problem": PROBLEM, "events": EVENTS, "examples": EXAMPLES}
    while args:
        a = args.pop(0)
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        key = a.lstrip("-")
        if a.startswith("--") and key in opts and args:
            opts[key] = Path(args.pop(0))
            continue
        print(f'Unknown argument "{a}". Run with --help.', file=sys.stderr)
        return 2
    try:
        platform = load(opts["platform"])
        lab = load(opts["lab"])
        codes = {c["code"]: c for c in load(opts["errors"])["codes"]}
        problem_schema = load(opts["problem"])
        events_schema = load(opts["events"])
    except (OSError, ValueError, KeyError, yaml.YAMLError) as e:
        print(f"cannot read an input: {e}", file=sys.stderr)
        return 1
    problems = [f"fragment: {m}" for m in check_fragment(platform, codes=codes, problem_schema=problem_schema, events_schema=events_schema, examples_dir=opts["examples"])]
    if opts["bundle"].exists() and opts["report"].exists():
        try:
            bundle, report = load(opts["bundle"]), load(opts["report"])
        except (OSError, ValueError) as e:
            print(f"cannot read the bundle or its report: {e}", file=sys.stderr)
            return 1
        problems += [f"bundle: {m}" for m in check_bundle(bundle, report, platform, lab)]
    else:
        problems.append("bundle: contracts/api/bundle/openapi.json or bundle-report.json is missing (pnpm run contracts:bundle)")
    if problems:
        print(f"FAIL: {len(problems)} problem(s)", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    ops = len(operations(platform))
    print(f"OK: platform fragment {ops} operations; bundle valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
