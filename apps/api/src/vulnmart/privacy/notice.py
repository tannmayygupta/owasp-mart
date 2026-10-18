"""The consent notice (story P-16, FR-PRV-01 and FR-PRV-02): a versioned text, filled in per attempt, and its hash.

`data/consent-notice.txt` is the text with three markers (company, retention days, months the short record is kept). `render` fills them
in and returns the exact text a person is shown with its SHA-256; the browser sends that hash and the version back with the decision,
and a decision whose hash is not the one the server renders now is stale (ATT-CONSENT-STALE). A consent record keeps the rendered text
as it was shown, so what a person agreed to can be proved later even after the file changes.

The version and the hash of the template file are pinned together below. Editing the text without a new version is a start-up error and a
test failure: a version must always mean one text. To change the text, add a new line to `TEMPLATE_HASHES`, point `NOTICE_VERSION` at it
and keep the old line so that old records stay explainable.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from importlib import resources

NOTICE_VERSION = "2026-10-18.1"
TEMPLATE_HASHES = {
    "2026-10-18.1": "4f0083d88ae1b54cff6f76d1466a8a8fafaa0b43a944c3cb9b10975b25a885cc",
}
VERSION_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{1,3}$")
MAX_COMPANY = 120


class NoticeError(Exception):
    """The notice cannot be produced (the template does not match its pinned version, or the company name is unusable)."""


@dataclass(frozen=True, slots=True)
class Notice:
    version: str
    text: str
    sha256: str
    retention_days_shown: int
    company_name: str


def _template_text() -> str:
    raw = resources.files("vulnmart.privacy").joinpath("data/consent-notice.txt").read_text(encoding="utf-8")
    return "\n".join(line for line in raw.splitlines() if not line.startswith("#")).strip() + "\n"


def template_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_template() -> None:
    """Raise NoticeError unless the template file is the text pinned for `NOTICE_VERSION`. Called when the service is built."""
    expected = TEMPLATE_HASHES.get(NOTICE_VERSION)
    if expected is None or template_hash(_template_text()) != expected:
        raise NoticeError(f"the consent notice text does not match version {NOTICE_VERSION}: change the version when you change the text")


def render(*, company_name: str, retention_days: int, record_months: int) -> Notice:
    """The notice for one company: markers filled, hash computed over the exact text that is shown."""
    name = " ".join(company_name.split())  # one line, single spaces: a name never adds a paragraph to the text
    if not name or len(name) > MAX_COMPANY or any(ord(c) < 32 for c in name):
        raise NoticeError("company name is empty, too long or has control characters")
    if retention_days < 1 or record_months < 0:
        raise NoticeError("retention values are out of range")
    text = _template_text().replace("{{retention_days}}", str(retention_days)).replace("{{record_months}}", str(record_months))
    text = text.replace("{{company}}", name)  # last, so a company name cannot carry a marker that is then filled in
    return Notice(NOTICE_VERSION, text, hashlib.sha256(text.encode("utf-8")).hexdigest(), retention_days, name)
