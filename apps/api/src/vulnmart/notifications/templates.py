"""The email templates (FR-NTF-01): one registry, one strict rule set.

Every email type of the requirement is a `TemplateSpec`: the parameters it needs, the ones it may have, which of them is a
secret single-use link, and a function that builds the subject, the plain text and the HTML. The rules every template shares:

- The mail names its sender: "VulnMart", or, for mail sent for a company, "<company> via VulnMart" as the display name and a line in the body.
- It carries no flag, password or token other than its own single-use link. Parameters are an allow-list per template (an unknown
  name such as `password` or `token` is refused at enqueue), and only the parameter called `link` (or `undo_link`) may hold a URL.
- A link must be an absolute http or https URL with no spaces and no user name or password in it (never `javascript:`).
- Text that ends up in a header (the subject, the sender name) is one line with no control characters; every value placed in the
  HTML is escaped.
- A secret parameter (the links) is removed from the outbox row once the mail is sent (`EmailOutboxService.deliver`).
"""
from __future__ import annotations

import html
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from .service import InvalidParams, Rendered, UnknownTemplate

Params = Mapping[str, Any]

MAX_VALUE = 300
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_SPACE = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class TemplateSpec:
    name: str
    required: frozenset[str]
    build: Callable[[dict[str, str]], Rendered]
    optional: frozenset[str] = frozenset()
    secret: frozenset[str] = frozenset()  # parameters that open something; removed from the row after sending
    links: frozenset[str] = frozenset()  # parameters that must be URLs


def _line(value: str) -> str:
    """One line: whitespace and control characters collapse to single spaces."""
    return _SPACE.sub(" ", _CONTROL.sub(" ", value)).strip()


def _check_link(name: str, value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or re.search(r"\s", value):
        raise InvalidParams(f"{name} must be an absolute http or https link without spaces or credentials")
    return value


def _clean(spec: TemplateSpec, params: Params) -> dict[str, str]:
    """The parameters as one-line strings, after the allow-list, the required set, the types and the links are checked."""
    allowed = spec.required | spec.optional
    unknown = sorted(set(params) - allowed)
    if unknown:
        raise InvalidParams(f"{spec.name} has no parameter {unknown[0]!r}")
    missing = sorted(spec.required - set(params))
    if missing:
        raise InvalidParams(f"{spec.name} needs the parameter {missing[0]!r}")
    clean: dict[str, str] = {}
    for key, value in params.items():
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise InvalidParams(f"{key} must be a string or a whole number")
        text = _line(str(value))
        if not text or len(text) > MAX_VALUE and key not in spec.links:
            raise InvalidParams(f"{key} must be 1 to {MAX_VALUE} characters")
        if key in spec.links:
            if len(str(value)) > 2000:
                raise InvalidParams(f"{key} is too long")
            text = _check_link(key, str(value))
        clean[key] = text
    return clean


def _compose(subject: str, paragraphs: list[str], *, link: tuple[str, str] | None = None,
             sender_note: str | None = None, sender_name: str | None = None) -> Rendered:
    """Text and HTML from the same content. `sender_note` is the line that names the sender in the body."""
    note = sender_note or "This message was sent by VulnMart."
    text_parts = [*paragraphs]
    html_parts = [f"<p>{html.escape(p)}</p>" for p in paragraphs]
    if link:
        label, url = link
        text_parts.append(f"{label}\n{url}")
        html_parts.append(f'<p><a href="{html.escape(url, quote=True)}">{html.escape(label)}</a></p>'
                          f"<p>If the button or link does not work, copy this address into your browser:<br>{html.escape(url)}</p>")
    text_parts.append(note)
    html_parts.append(f'<p style="color:#555;font-size:13px">{html.escape(note)}</p>')
    body = "\n".join(html_parts)
    return Rendered(
        subject=_line(subject)[:150],
        text="\n\n".join(text_parts) + "\n",
        html=f'<!doctype html><html><body style="font-family:sans-serif;max-width:560px">{body}</body></html>',
        sender_name=_line(sender_name)[:70] if sender_name else None,  # None: the provider's default, "VulnMart"
    )


def _via(org: str) -> str:
    return f"{org} via VulnMart"


# ---- the nine types of FR-NTF-01 -------------------------------------------------------------------------------------

def _verify(p: dict[str, str]) -> Rendered:
    hours = p.get("expires_in_hours")
    return _compose("Confirm your email address for VulnMart", [
        "Welcome to VulnMart. Please confirm that this is your email address so that you can use your account.",
        f"The link works once and expires in {hours} hours." if hours else "The link works once and expires.",
        "If you did not create an account, you can ignore this message.",
    ], link=("Confirm my email address", p["link"]))


def _reset(p: dict[str, str]) -> Rendered:
    hours = p.get("expires_in_hours")
    return _compose("Reset your VulnMart password", [
        "Someone asked to reset the password of this VulnMart account. If it was you, use the link to choose a new password.",
        f"The link works once and expires in {hours} hours." if hours else "The link works once and expires.",
        "If you did not ask for this, ignore this message: your password has not changed.",
    ], link=("Choose a new password", p["link"]))


def _admin_created(p: dict[str, str]) -> Rendered:
    """To someone an admin made an admin account for (FR-ACC-11): the link lets them choose their own password."""
    hours = p.get("expires_in_hours")
    return _compose("A VulnMart administrator account was created for you", [
        "An administrator of VulnMart created an administrator account for this email address. Use the link to choose a password.",
        f"The link works once and expires in {hours} hours." if hours else "The link works once and expires.",
        "Signing in as an administrator will also need an authenticator app. If you did not expect this, ignore this message: the account stays unusable.",
    ], link=("Choose a password", p["link"]))


def _already_registered(p: dict[str, str]) -> Rendered:
    """Sent when someone signs up with an address that already has an account (the signup answer is the same either way, FR-ACC-01)."""
    return _compose("Someone tried to sign up with your email address", [
        "Someone tried to create a VulnMart account with this email address, which already has one.",
        "If it was you, sign in with your existing password, or reset it if you forgot it. If it was not you, you can ignore this message: nothing changed.",
    ], link=("Sign in to VulnMart", p["login_url"]) if "login_url" in p else None)


def _approval(p: dict[str, str]) -> Rendered:
    org = p["org_name"]
    if p["outcome"] == "approved":
        return _compose(f"{org} is approved on VulnMart", [
            f"Your company {org} has been approved. You can now sign in and invite candidates to assessments.",
        ], link=("Sign in to VulnMart", p["login_url"]) if "login_url" in p else None)
    if p["outcome"] == "rejected":
        return _compose(f"Your application for {org} was not approved", [
            f"The application for {org} was not approved.",
            f"Reason given by the reviewer: {p['reason']}" if "reason" in p else "No reason was recorded.",
        ])
    raise InvalidParams("outcome must be 'approved' or 'rejected'")


def _invite(p: dict[str, str]) -> Rendered:
    org, assessment = p["org_name"], p["assessment_name"]
    days = p.get("expires_in_days")
    return _compose(f"{org} invited you to a security assessment", [
        f"{org} has invited you to take the assessment \"{assessment}\" on VulnMart.",
        "Before you start you will see what data is collected and you can decide whether to consent.",
        f"The invitation works once and expires in {days} days." if days else "The invitation works once and expires.",
    ], link=("Open the invitation", p["link"]),
        sender_note=f"This invitation was sent by {org} through VulnMart. Reply to {org}, not to VulnMart, about the assessment.",
        sender_name=_via(org))


def _withdrawn(p: dict[str, str]) -> Rendered:
    org = p["org_name"]
    return _compose("A candidate withdrew consent", [
        f"A candidate withdrew consent for the assessment \"{p['assessment_name']}\" of {org}.",
        f"Their data will be deleted on {p['deletion_on']} unless they undo the withdrawal before then." if "deletion_on" in p
        else "Their data will be deleted after the undo window unless they undo the withdrawal.",
        "Their results are no longer part of your assessment once the data is deleted.",
    ], sender_note=f"This message was sent by VulnMart to {org}.")


def _deletion_requested(p: dict[str, str]) -> Rendered:
    paragraphs = ["We received your request to delete your data."]
    if "deletion_on" in p:
        paragraphs.append(f"The deletion runs on {p['deletion_on']}. Until then you can undo the request.")
    if "company_name" in p:
        paragraphs.append(f"Your request goes to {p['company_name']}, which decides on it. You will be told the result.")
    return _compose("We received your deletion request", paragraphs,
                    link=("Undo the request", p["undo_link"]) if "undo_link" in p else None)


def _deletion_for_company(p: dict[str, str]) -> Rendered:
    org = p["org_name"]
    return _compose("A candidate asked for their data to be deleted", [
        f"A candidate asked {org} to delete their data from the assessment \"{p['assessment_name']}\".",
        f"Please decide by {p['decide_by']}. If nobody decides, the request is reminded and then passed to a VulnMart admin.",
    ], link=("Open the request", p["link"]) if "link" in p else None, sender_note=f"This message was sent by VulnMart to {org}.")


def _deletion_confirmed(p: dict[str, str]) -> Rendered:
    return _compose("Your data has been deleted", [
        "The deletion you asked for is complete." if "completed_on" not in p else f"The deletion you asked for was completed on {p['completed_on']}.",
        "Nothing in this message can be used to sign in; we keep no copy of the deleted data.",
    ])


def _retention(p: dict[str, str]) -> Rendered:
    return _compose("Your VulnMart data will be deleted soon", [
        f"You have not signed in to VulnMart for almost a year. Your learner data will be deleted on {p['delete_on']}.",
        "To keep it, sign in before that date and the deletion is cancelled. If you want it deleted, you need do nothing.",
    ], link=("Sign in to VulnMart", p["login_url"]))


def _system_test(p: dict[str, str]) -> Rendered:
    return _compose("VulnMart test message", ["This is a test message from VulnMart."])


def _spec(name: str, required: set[str], build, *, optional: set[str] = frozenset(), links: set[str] = frozenset(),
          secret: set[str] = frozenset()) -> TemplateSpec:
    return TemplateSpec(name, frozenset(required), build, frozenset(optional), frozenset(secret), frozenset(links))


TEMPLATES: dict[str, TemplateSpec] = {s.name: s for s in (
    _spec("account.verify", {"link"}, _verify, optional={"expires_in_hours"}, links={"link"}, secret={"link"}),
    _spec("account.password_reset", {"link"}, _reset, optional={"expires_in_hours"}, links={"link"}, secret={"link"}),
    _spec("account.already_registered", set(), _already_registered, optional={"login_url"}, links={"login_url"}),
    _spec("account.admin_created", {"link"}, _admin_created, optional={"expires_in_hours"}, links={"link"}, secret={"link"}),
    _spec("org.approval_outcome", {"org_name", "outcome"}, _approval, optional={"reason", "login_url"}, links={"login_url"}),
    _spec("candidate.invite", {"org_name", "assessment_name", "link"}, _invite, optional={"expires_in_days"}, links={"link"}, secret={"link"}),
    _spec("recruiter.consent_withdrawn", {"org_name", "assessment_name"}, _withdrawn, optional={"deletion_on"}),
    _spec("privacy.deletion_requested", set(), _deletion_requested, optional={"deletion_on", "company_name", "undo_link"},
          links={"undo_link"}, secret={"undo_link"}),
    _spec("privacy.deletion_request_for_company", {"org_name", "assessment_name", "decide_by"}, _deletion_for_company,
          optional={"link"}, links={"link"}),
    _spec("privacy.deletion_confirmed", set(), _deletion_confirmed, optional={"completed_on"}),
    _spec("learner.retention_warning", {"delete_on", "login_url"}, _retention, links={"login_url"}),
    _spec("system.test", set(), _system_test),
)}

# The types of FR-NTF-01 (the list the requirement names); `system.test` is for operators and tests only.
EMAIL_TYPES = tuple(n for n in TEMPLATES if n != "system.test")


def validate_params(template: str, params: Params) -> None:
    """Refuse a template name or parameters that would fail at delivery. Used at enqueue, in the cause's transaction."""
    spec = TEMPLATES.get(template)
    if spec is None:
        raise InvalidParams(f"unknown email template {template!r}")
    _clean(spec, params)


class TemplateRenderer:
    """The `Renderer` of the platform: the registry above. Unknown names raise UnknownTemplate; bad parameters InvalidParams."""

    def render(self, template: str, params: Params) -> Rendered:
        spec = TEMPLATES.get(template)
        if spec is None:
            raise UnknownTemplate(template)
        return spec.build(_clean(spec, params))

    def secret_params(self, template: str) -> frozenset[str]:
        spec = TEMPLATES.get(template)
        return spec.secret if spec else frozenset()
