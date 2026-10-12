"""Checks the generated Pydantic models (vulnmart_models.api) against the request and response examples of IF-1.

  - every valid example in contracts/api/platform/examples/valid is accepted by the model of its schema
  - every invalid example is refused by it (the examples were written to break one rule each)
  - the Problem model accepts the error example of every registry code and refuses a body with an extra member

Run: uv run --locked --package vulnmart-models python scripts/check_api_models.py
Exit code 0 when all checks pass, 1 otherwise.
"""

import json
import sys
from pathlib import Path

from pydantic import ValidationError

from vulnmart_models import api
from vulnmart_models.error_codes import ERRORS, ErrorCode, problem_type

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "contracts" / "api" / "platform" / "examples"


# Rules of the schema the generated models do not express; the bundle (jsonschema, format "email" included) is what enforces them.
# An object needing at least one member has no Pydantic field form, and an address is a plain string in the models (see generate-api-code.mjs).
NOT_EXPRESSED = {"at least one member", "an email address"}


def load(kind: str) -> list[tuple[str, dict]]:
    return [(p.name, json.loads(p.read_text(encoding="utf8"))) for p in sorted((EXAMPLES / kind).glob("*.json"))]


def main() -> int:
    problems: list[str] = []
    checked = 0
    for kind, must_pass in (("valid", True), ("invalid", False)):
        for name, ex in load(kind):
            if not must_pass and ex.get("rule") in NOT_EXPRESSED:
                continue
            model = getattr(api, ex["schema"], None)
            if model is None:
                problems.append(f"{kind}/{name}: no model named {ex['schema']}")
                continue
            checked += 1
            try:
                model.model_validate(ex["body"])
                accepted = True
            except ValidationError:
                accepted = False
            if accepted != must_pass:
                problems.append(f"{kind}/{name}: {ex['schema']} {'refused' if must_pass else 'accepted'} the body")

    for code, info in ERRORS.items():
        body = {"type": problem_type(code), "title": info.title, "status": info.status or 500, "code": code.value, "request_id": "req-0a1b2c3d"}
        checked += 1
        try:
            api.Problem.model_validate(body)
        except ValidationError as e:
            problems.append(f"Problem refused the body of {code.value}: {e.errors()[0]['msg']}")
    checked += 1
    try:
        api.Problem.model_validate({"type": problem_type(ErrorCode.AUTH_INVALID_CREDENTIALS), "title": "x", "status": 401, "code": "AUTH-INVALID-CREDENTIALS", "request_id": "r", "detail": "extra"})
        problems.append("Problem accepted a body with a member the closed body does not have")
    except ValidationError:
        pass

    for p in problems:
        print(f"FAIL: {p}")
    print(f"{'FAILED' if problems else 'OK'}: {checked} checks, {len(problems)} problem(s).")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
