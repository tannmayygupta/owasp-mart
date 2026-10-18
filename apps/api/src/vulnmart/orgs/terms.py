"""The data-processing terms a company accepts before it can invite candidates (story P-19, FR-ORG-07).

`data/dpa-terms.txt` is the text with one marker (the company name). `render` fills it in and returns the exact text the owner is shown with its SHA-256; the
acceptance repeats the version and the hash and a different hash is stale. The acceptance record keeps the version and the hash. As for the consent notice,
the version and the hash of the template file are pinned together: editing the text without a new version is a start-up error and a test failure.
The wording is a draft that no lawyer has reviewed (OI-33).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from importlib import resources

TERMS_VERSION = "2026-10-18.1"
TEMPLATE_HASHES = {
    "2026-10-18.1": "3422968480270adf19a0a4d56f8be89fdfdc34470dbcbd64bd2953d9518f132b",
}
MAX_COMPANY = 120


class TermsError(Exception):
    """The terms cannot be produced (the template does not match its pinned version, or the company name is unusable)."""


@dataclass(frozen=True, slots=True)
class Terms:
    version: str
    text: str
    sha256: str


def _template_text() -> str:
    raw = resources.files("vulnmart.orgs").joinpath("data/dpa-terms.txt").read_text(encoding="utf-8")
    return "\n".join(line for line in raw.splitlines() if not line.startswith("#")).strip() + "\n"


def template_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_template() -> None:
    expected = TEMPLATE_HASHES.get(TERMS_VERSION)
    if expected is None or template_hash(_template_text()) != expected:
        raise TermsError(f"the terms text does not match version {TERMS_VERSION}: change the version when you change the text")


def render(*, company_name: str) -> Terms:
    name = " ".join(company_name.split())
    if not name or len(name) > MAX_COMPANY or any(ord(c) < 32 for c in name):
        raise TermsError("company name is empty, too long or has control characters")
    text = _template_text().replace("{{company}}", name)
    return Terms(TERMS_VERSION, text, hashlib.sha256(text.encode("utf-8")).hexdigest())
