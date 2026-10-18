"""Disposable email domains (story P-18, FR-ACC-10: "a disposable-domain email cannot start a recruiter signup"; FR-ORG-04).

The bundled list `data/disposable-domains.txt` is a starter list from memory, not a maintained one (see its header). A listed domain and every
subdomain of it are refused. Free webmail such as gmail.com is NOT on the list: the developer decided on 2026-10-18 (OI-10) that recruiters with a
free address are allowed without an extra check.
"""
from __future__ import annotations

from functools import lru_cache
from importlib import resources


@lru_cache(maxsize=1)
def disposable_domains() -> frozenset[str]:
    text = resources.files("vulnmart.orgs").joinpath("data/disposable-domains.txt").read_text(encoding="utf-8")
    return frozenset(line.strip().lower() for line in text.splitlines() if line.strip() and not line.startswith("#"))


def domain_of(email_ci: str) -> str:
    """The domain of a canonical address (the part after the last @), lower case, without a trailing dot."""
    return email_ci.rsplit("@", 1)[-1].strip().lower().rstrip(".")


def is_disposable(email_ci: str) -> bool:
    domain = domain_of(email_ci)
    listed = disposable_domains()
    parts = domain.split(".")
    return any(".".join(parts[i:]) in listed for i in range(len(parts) - 1))
