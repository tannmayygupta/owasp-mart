"""Spec versus routes: every operation of the platform contract (contracts/api/bundle/openapi.json) is served by a FastAPI route with the same method, path and operationId, and
every /api/v1 route the API serves is in the contract (the wiring audit of 2026-10-21 found this was checked only by a live-only script).

It imports the routers of the API packages (no database, no Valkey, no network) and the health route that `create_app` mounts, so it runs in the `scripts` CI job.
Two exemptions, each only while the route is absent: `createLiveTicket` (the contract marks it `x-pending`, waiting for the spike S-14, and the exemption also needs that mark), and `startAttempt`
(the contract says "PENDING OI-22": the clock may start when the instance becomes ready, in which case the route is removed; the API serves no /start route and OI-22 is not decided
here). Once a route exists, or the contract drops the operation, the check fails and asks for the exemption to be removed.

Usage: python scripts/check_spec_routes.py [--bundle FILE]     exit 0 when the two agree, 1 with the differences, 2 on a usage error.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "contracts" / "api" / "bundle" / "openapi.json"
METHODS = ("get", "put", "post", "delete", "patch")
# The routers of the API packages (each module has a `router`).
ROUTER_MODULES = (
    "vulnmart.accounts.api", "vulnmart.accounts.me_api", "vulnmart.accounts.mfa_api", "vulnmart.accounts.password_api", "vulnmart.accounts.session_api",
    "vulnmart.admin.api", "vulnmart.assessments.invite_api", "vulnmart.lab.api", "vulnmart.live.api", "vulnmart.orgs.company_api",
    "vulnmart.privacy.api", "vulnmart.privacy.deletion_api", "vulnmart.privacy.export_api",
)
# operation id -> does the contract have to mark it `x-pending` for the exemption to hold
PENDING = {"createLiveTicket": True, "startAttempt": False}  # contract-pending, deliberately not served (spike S-14; OI-22)


def spec_operations(bundle: dict) -> dict[tuple[str, str], tuple[str, bool]]:
    out = {}
    for path, item in bundle["paths"].items():
        for method in METHODS:
            op = item.get(method)
            if op:
                out[(method.upper(), path)] = (op["operationId"], bool(op.get("x-pending")))
    return out


def route_operations() -> dict[tuple[str, str], str]:
    """(METHOD, path) -> operation id of every served /api/v1 route."""
    os.environ.setdefault("VULNMART_ENV", "test")
    routes = []
    for name in ROUTER_MODULES:
        routes.extend(importlib.import_module(name).router.routes)
    from vulnmart.main import create_app  # the health route is mounted by the kernel, not by a router module

    routes.extend(create_app().routes)
    out = {}
    for route in routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", "")
        if not methods or not path.startswith("/api/v1/"):
            continue
        for method in methods:
            if method in ("HEAD", "OPTIONS"):
                continue
            out[(method, path)] = getattr(route, "operation_id", None) or getattr(route, "name", "")
    return out


def compare(spec: dict, routes: dict) -> list[str]:
    problems = []
    for (method, path), (operation_id, pending) in sorted(spec.items()):
        got = routes.get((method, path))
        if got is None:
            if operation_id in PENDING and (pending or not PENDING[operation_id]):
                continue
            problems.append(f"in the contract, not served: {method} {path} ({operation_id})")
        else:
            if operation_id in PENDING:
                problems.append(f"{operation_id} is served now ({method} {path}): remove it from PENDING in this script and from the verify-deployed exemption")
            if got != operation_id:
                problems.append(f"operationId differs for {method} {path}: the contract says {operation_id}, the route says {got}")
    for operation_id in sorted(PENDING):
        entry = [(k, v) for k, v in spec.items() if v[0] == operation_id]
        if not entry:
            problems.append(f"{operation_id} is exempt here but is not in the contract any more: remove it from PENDING")
        elif PENDING[operation_id] and not entry[0][1][1] and entry[0][0] not in routes:
            problems.append(f"{operation_id} is exempt but the contract no longer marks it x-pending and no route serves it")
    for (method, path), operation_id in sorted(routes.items()):
        if (method, path) not in spec:
            problems.append(f"served, not in the contract: {method} {path} ({operation_id})")
    return problems


def main(argv: list[str]) -> int:
    bundle = BUNDLE
    if argv and argv[0] == "--bundle" and len(argv) == 2:
        bundle = Path(argv[1])
    elif argv:
        print("usage: python scripts/check_spec_routes.py [--bundle FILE]", file=sys.stderr)
        return 2
    spec = spec_operations(json.loads(bundle.read_text(encoding="utf-8")))
    routes = route_operations()
    problems = compare(spec, routes)
    for p in problems:
        print(f"FAIL {p}")
    if problems:
        print(f"{len(problems)} difference(s) between the contract and the routes")
        return 1
    print(f"PASS the contract and the routes agree: {len(routes)} routes, {len(spec)} operations, {len(set(PENDING) & {v[0] for v in spec.values()})} exempt as pending")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
