"""Story P-10: the email templates of FR-NTF-01 (every type renders, names its sender, carries no secret but its own link) and their
use through the outbox (validation at enqueue, secrets removed after sending)."""
from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.notifications.models  # noqa: F401
from vulnmart.kernel.db import Base
from vulnmart.notifications.fakes import FakeEmailProvider, StaticRecipients
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.provider import SmtpProvider
from vulnmart.notifications.service import REMOVED, DbOutboxPort, EmailOutboxService, InvalidParams, UnknownTemplate
from vulnmart.notifications.templates import EMAIL_TYPES, TEMPLATES, TemplateRenderer, validate_params
from vulnmart.ports.fakes import FakeOutboxPort, FakeSettingsPort

LINK = "https://vulnmart.example/verify?t=single-use-value"
SAMPLES: dict[str, dict] = {
    "account.verify": {"link": LINK, "expires_in_hours": 24},
    "account.password_reset": {"link": LINK, "expires_in_hours": 24},
    "account.already_registered": {"login_url": "https://vulnmart.example/login"},
    "account.admin_created": {"link": LINK, "expires_in_hours": 24},
    "org.approval_outcome": {"org_name": "Acme Security", "outcome": "approved", "login_url": "https://vulnmart.example/login"},
    "candidate.invite": {"org_name": "Acme Security", "assessment_name": "Web basics", "link": LINK, "expires_in_days": 7},
    "recruiter.consent_withdrawn": {"org_name": "Acme Security", "assessment_name": "Web basics", "deletion_on": "2026-10-24"},
    "privacy.deletion_requested": {"deletion_on": "2026-10-24", "undo_link": LINK},
    "privacy.deletion_request_for_company": {"org_name": "Acme Security", "assessment_name": "Web basics", "decide_by": "2026-10-31",
                                             "link": "https://vulnmart.example/requests/1"},
    "privacy.deletion_confirmed": {"completed_on": "2026-10-24"},
    "learner.retention_warning": {"delete_on": "2026-11-16", "login_url": "https://vulnmart.example/login"},
    "instance.force_stopped": {},
    "admin.break_glass_opened": {"grant_id": "g-AAAAAAAAAAAAAAAA", "minutes": "15"},
    "company.break_glass_opened": {"minutes": "15"},
    "security.incident_notice": {"summary": "A test incident.", "advice": "Change your password."},
}
FORBIDDEN_NAMES = ("password", "token", "flag", "secret", "api_key", "email", "address", "to")


def test_the_samples_cover_every_type():
    # nine types of FR-NTF-01, `account.already_registered` that the signup contract asks for (story P-11) and `account.admin_created` (story P-13)
    assert set(SAMPLES) == set(EMAIL_TYPES) and len(EMAIL_TYPES) == 15  # story P-31 added the two break-glass alerts and the incident notice


@pytest.mark.parametrize("name", EMAIL_TYPES)
def test_every_type_renders_text_and_html_that_name_the_sender(name):
    rendered = TemplateRenderer().render(name, SAMPLES[name])
    assert rendered.subject and "\n" not in rendered.subject and len(rendered.subject) <= 150
    assert rendered.text.strip() and rendered.html and rendered.html.startswith("<!doctype html>")
    assert "VulnMart" in rendered.text and "VulnMart" in rendered.html, "the mail names its sender"
    if name == "candidate.invite":
        assert rendered.sender_name == "Acme Security via VulnMart"
    else:
        assert rendered.sender_name is None


@pytest.mark.parametrize("name", EMAIL_TYPES)
def test_a_mail_contains_no_address_but_the_links_it_was_given(name):
    params = SAMPLES[name]
    rendered = TemplateRenderer().render(name, params)
    given = {v for k, v in params.items() if k in TEMPLATES[name].links}
    for body in (rendered.text, rendered.html):
        found = set(re.findall(r"https?://[^\s\"'<>]+", body))
        assert found <= given, f"{name} shows a URL that was not a parameter: {found - given}"
    assert "[removed" not in rendered.text


@pytest.mark.parametrize("name", EMAIL_TYPES)
@pytest.mark.parametrize("forbidden", FORBIDDEN_NAMES)
def test_a_password_token_flag_or_address_parameter_is_refused(name, forbidden):
    with pytest.raises(InvalidParams):
        validate_params(name, {**SAMPLES[name], forbidden: "x"})


@pytest.mark.parametrize("name", [n for n in EMAIL_TYPES if TEMPLATES[n].required])
def test_a_missing_required_parameter_is_refused(name):
    params = dict(SAMPLES[name])
    params.pop(sorted(TEMPLATES[name].required)[0])
    with pytest.raises(InvalidParams):
        validate_params(name, params)
    with pytest.raises(InvalidParams):
        TemplateRenderer().render(name, params)


@pytest.mark.parametrize("bad", [
    "javascript:alert(1)", "//vulnmart.example/x", "vulnmart.example/x", "https://user:pw@vulnmart.example/x",
    "https://vulnmart.example/a b", "ftp://vulnmart.example/x", "https:///nohost",
])
def test_a_link_must_be_a_plain_http_or_https_url(bad):
    with pytest.raises(InvalidParams):
        validate_params("account.verify", {"link": bad})


def test_value_types_and_sizes_are_checked():
    for bad in ({"org_name": True, "outcome": "approved"}, {"org_name": ["a"], "outcome": "approved"}, {"org_name": "", "outcome": "approved"},
                {"org_name": "x" * 301, "outcome": "approved"}, {"org_name": "A", "outcome": "maybe"}):
        with pytest.raises(InvalidParams):
            TemplateRenderer().render("org.approval_outcome", bad)


def test_text_that_reaches_a_header_is_one_line():
    hostile = "Acme\r\nBcc: attacker@example.invalid\r\nSubject: x"
    rendered = TemplateRenderer().render("candidate.invite", {**SAMPLES["candidate.invite"], "org_name": hostile})
    assert "\r" not in rendered.subject and "\n" not in rendered.subject
    assert "\r" not in rendered.sender_name and "\n" not in rendered.sender_name
    assert rendered.sender_name.endswith("via VulnMart") or len(rendered.sender_name) == 70


def test_everything_placed_in_the_html_is_escaped():
    rendered = TemplateRenderer().render("candidate.invite", {**SAMPLES["candidate.invite"], "org_name": "<script>alert(1)</script>",
                                                              "assessment_name": '"><img src=x onerror=1>'})
    assert "<script>" not in rendered.html and "<img" not in rendered.html
    assert "&lt;script&gt;" in rendered.html


def test_a_link_in_the_html_is_escaped_inside_its_attribute():
    rendered = TemplateRenderer().render("account.verify", {"link": 'https://vulnmart.example/v?a=1&b="2"'})
    assert 'href="https://vulnmart.example/v?a=1&amp;b=&quot;2&quot;"' in rendered.html


def test_an_unknown_template_is_unknown():
    with pytest.raises(UnknownTemplate):
        TemplateRenderer().render("nope", {})
    with pytest.raises(InvalidParams):
        validate_params("nope", {})


def test_the_real_smtp_builder_accepts_every_rendered_mail(monkeypatch):
    """The rendered subject and sender name go into headers: the standard library refuses a header with a newline."""
    import smtplib

    seen = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def send_message(self, message):
            seen.append(message)

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    from vulnmart.notifications.provider import OutgoingEmail

    for name in EMAIL_TYPES:
        r = TemplateRenderer().render(name, SAMPLES[name])
        SmtpProvider("h").send(OutgoingEmail(to="a@example.invalid", subject=r.subject, text=r.text, html=r.html,
                                             sender_name=r.sender_name or "VulnMart"))
    assert len(seen) == len(EMAIL_TYPES)
    assert all(m.get_body(("plain",)) is not None and m.get_body(("html",)) is not None for m in seen)


# ---- through the outbox ----------------------------------------------------------------------------------------------

@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[EmailOutbox.__table__])
    return sessionmaker(engine, expire_on_commit=False)


T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)


def service_for(sessions, provider):
    return EmailOutboxService(sessions, provider, StaticRecipients({"u1": "ada@example.invalid"}), TemplateRenderer(),
                              FakeSettingsPort({"email_daily_cap": 0}), now=lambda: T0)


def enqueue(sessions, template, params, *, validate=True):
    with sessions.begin() as session:
        port = DbOutboxPort(lambda: session, FakeOutboxPort(), now=lambda: T0, validator=validate_params if validate else None)
        return port.enqueue_email(template=template, to_user_id="u1", params=params).id


def test_every_type_goes_through_the_outbox_and_is_sent(sessions):
    provider = FakeEmailProvider()
    service = service_for(sessions, provider)
    ids = [enqueue(sessions, name, SAMPLES[name]) for name in EMAIL_TYPES]
    assert service.claim_due() == ids
    assert [service.deliver(i) for i in ids] == ["sent"] * len(EMAIL_TYPES)
    assert len(provider.sent) == len(EMAIL_TYPES) and {m.to for m in provider.sent} == {"ada@example.invalid"}
    invite = next(m for m in provider.sent if "invited you" in m.subject)
    assert invite.sender_name == "Acme Security via VulnMart" and LINK in invite.text


def test_the_single_use_link_is_removed_from_the_row_once_sent(sessions):
    service = service_for(sessions, FakeEmailProvider())
    (verify, approved) = (enqueue(sessions, "account.verify", SAMPLES["account.verify"]),
                          enqueue(sessions, "org.approval_outcome", SAMPLES["org.approval_outcome"]))
    service.claim_due()
    service.deliver(verify), service.deliver(approved)
    with sessions() as session:
        rows = {r.id: r.params for r in session.scalars(select(EmailOutbox))}
    assert rows[verify] == {"link": REMOVED, "expires_in_hours": 24}
    assert rows[approved] == SAMPLES["org.approval_outcome"], "a login address is not a secret and stays"


def test_a_failed_row_keeps_its_link_so_an_admin_can_requeue_it(sessions):
    from vulnmart.notifications.provider import PermanentSendError

    service = service_for(sessions, FakeEmailProvider([PermanentSendError("provider-refused")]))
    outbox_id = enqueue(sessions, "account.verify", SAMPLES["account.verify"])
    service.claim_due()
    assert service.deliver(outbox_id) == "failed"
    with sessions() as session:
        assert session.get(EmailOutbox, outbox_id).params["link"] == LINK


def test_enqueue_refuses_a_bad_template_or_bad_parameters_and_stores_nothing(sessions):
    for name, params in (("nope", {}), ("account.verify", {}), ("account.verify", {"link": "javascript:x"}),
                         ("account.verify", {"link": LINK, "password": "hunter2"})):
        with sessions.begin() as session:
            port = DbOutboxPort(lambda: session, FakeOutboxPort(), validator=validate_params)
            with pytest.raises(ValueError):
                port.enqueue_email(template=name, to_user_id="u1", params=params)
    with sessions() as session:
        assert session.scalars(select(EmailOutbox)).all() == []


def test_parameters_that_slipped_past_enqueue_fail_at_delivery_without_a_send(sessions):
    provider = FakeEmailProvider()
    service = service_for(sessions, provider)
    outbox_id = enqueue(sessions, "account.verify", {"link": "javascript:x"}, validate=False)
    service.claim_due()
    assert service.deliver(outbox_id) == "failed"
    with sessions() as session:
        assert session.get(EmailOutbox, outbox_id).last_error_code == "bad-params"
    assert provider.calls == 0
