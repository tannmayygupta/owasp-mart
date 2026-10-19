"""Story P-24 (FR-PRV-07, FR-PRV-16): what the platform tells people about roles and about retention. The data-processing terms name the company as controller and VulnMart as
processor of candidate data and VulnMart as controller of learner data; the consent notice says the company decides; and nothing a person is shown (the notice, the terms and every
email) claims a legal duty that the research does not support: the automatic deletion, the 180-day default, the 7-day undo and the 30-day learner warning are product choices
(D-25), and the 48-hour pre-erasure notice is not claimed as a duty at all."""
from __future__ import annotations

import re

import pytest

from vulnmart.notifications.templates import TEMPLATES
from vulnmart.orgs import terms
from vulnmart.privacy import notice

# Phrases that would present a product choice or a research-unsupported rule as a legal duty of VulnMart.
CLAIMS = [
    r"48[\s-]?hours?",
    r"\b(legal|statutory|regulatory)\s+(duty|obligation|requirement|mandate)",
    r"\brequired\s+(by|under)\s+(the\s+)?(law|dpdp|gdpr|act|regulation)",
    r"\b(we|vulnmart)\s+(are|is)\s+(legally\s+)?(obliged|required|bound)\b",
    r"\bby\s+law\b",
    r"\bcomplian(t|ce)\s+with\s+(the\s+)?(dpdp|gdpr)",
]


def all_texts() -> dict[str, str]:
    texts = {"the consent notice": notice.render(company_name="Acme", retention_days=180, record_months=12).text,
             "the data-processing terms": terms.render(company_name="Acme").text}
    for name, spec in TEMPLATES.items():
        params = {k: ("https://example.test/x" if k in spec.links else "Sample") for k in spec.required | spec.optional}
        if "outcome" in params:
            params["outcome"] = "approved"
        rendered = spec.build(params)
        texts[f"the email {name}"] = f"{rendered.subject}\n{rendered.text}\n{rendered.html or ''}"
    return texts


@pytest.mark.parametrize("where,text", sorted(all_texts().items()))
def test_nothing_a_person_is_shown_claims_a_legal_duty_or_the_48_hour_notice(where, text):
    for claim in CLAIMS:
        assert re.search(claim, text, re.IGNORECASE) is None, f"{where} says something matching {claim!r}"


def test_the_scan_would_catch_such_a_claim():
    for bad in ("We are required by law to delete your data 48 hours after.", "This is a legal obligation of VulnMart.", "VulnMart is obliged to warn you.", "Deleted by law."):
        assert any(re.search(c, bad, re.IGNORECASE) for c in CLAIMS), bad


def test_the_terms_name_the_company_as_controller_and_vulnmart_as_processor_of_candidate_data_and_vulnmart_as_controller_of_learner_data():
    text = terms.render(company_name="Acme Security Ltd").text
    assert "Acme Security Ltd decides why and how the results of its candidates are used. Acme Security Ltd is the controller of that data." in text
    assert "VulnMart is the processor of that data." in text
    assert re.search(r"learner who uses VulnMart without an assessment, VulnMart is the controller", text)
    assert "Acme Security Ltd has no part in that data and never sees it" in text


def test_a_change_of_the_terms_text_came_with_a_new_version():
    terms.check_template()
    assert terms.TERMS_VERSION == "2026-10-19.1"


def test_the_consent_notice_tells_the_candidate_who_decides_and_that_deletion_is_after_a_number_of_days_not_a_law():
    text = notice.render(company_name="Acme", retention_days=180, record_months=12).text
    assert "Acme decides how the results are used" in text and "VulnMart runs the test shop and keeps the records for them" in text
    assert "deleted 180 days after the assessment" in text


def test_the_learner_warning_says_what_will_happen_and_how_to_stop_it_and_nothing_more():
    spec = TEMPLATES["learner.retention_warning"]
    rendered = spec.build({"delete_on": "2027-10-19", "login_url": "https://example.test/login"})
    assert "deleted on 2027-10-19" in rendered.text and "sign in before that date and the deletion is cancelled" in rendered.text
