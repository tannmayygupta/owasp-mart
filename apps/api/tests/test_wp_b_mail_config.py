"""Work package B (FR-NTF-03, wiring finding F-03): production does not start with mail that reaches nobody.

The unit tests drive `validate_mail_settings` with real `Settings` objects, the worker's `make_provider` and `create_app` (the two processes that would send or take mail), and the
deployment test reads the compose file that is deployed. The last one is expected to fail until the work package that owns `infra/deploy/platform.compose.yaml` (WP-C) sets Brevo
there: it is marked xfail with that reason, and its rule is checked by a second test on a block that is right, so the rule itself is never untested."""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from vulnmart.kernel.settings import Settings
from vulnmart.notifications.config import check_deployed_env, validate_mail_settings
from vulnmart.notifications.provider import BrevoApiProvider
from vulnmart.notifications.worker import make_provider

ROOT = Path(__file__).resolve().parents[3]
GOOD = {"env": "production", "email_provider": "brevo", "brevo_api_key": "test-key-not-real", "email_sender_address": "no-reply@vulnmart.app"}


def settings(**over) -> Settings:
    return Settings(_env_file=None, **{**GOOD, **over})


def test_a_production_with_brevo_a_key_and_a_real_sender_is_accepted():
    validate_mail_settings(settings())


@pytest.mark.parametrize("over, words", [
    ({"email_provider": "smtp", "smtp_host": "mailpit"}, ["production sends through Brevo only", "mail catcher"]),
    ({"email_provider": "smtp", "smtp_host": None}, ["production sends through Brevo only"]),
    ({"brevo_api_key": None}, ["needs VULNMART_BREVO_API_KEY"]),
    ({"email_sender_address": "no-reply@vulnmart.invalid"}, ["placeholder"]),
    ({"email_sender_address": "not an address"}, ["real address"]),
])
def test_each_wrong_production_mail_setting_fails_the_start_and_names_the_variable(over, words):
    with pytest.raises(RuntimeError) as err:
        validate_mail_settings(settings(**over))
    for word in words:
        assert word in str(err.value)
    assert "test-key-not-real" not in str(err.value), "the key is never printed"


def test_a_catcher_host_is_ignored_while_brevo_is_the_provider():
    # the deployed compose names Mailpit for its optional catcher profile; the host is only used when SMTP is the provider (which production refuses)
    validate_mail_settings(settings(smtp_host="mailpit"))


def test_dev_staging_and_test_keep_mailpit():
    for env in ("dev", "test", "staging"):
        validate_mail_settings(settings(env=env, email_provider="smtp", smtp_host="mailpit", brevo_api_key=None, email_sender_address="no-reply@vulnmart.invalid"))


def test_the_key_can_come_from_a_file(tmp_path):
    key = tmp_path / "brevo"
    key.write_text("file-key-not-real\n", encoding="utf-8")
    validate_mail_settings(settings(brevo_api_key=None, brevo_api_key_file=str(key)))
    assert isinstance(make_provider(settings(brevo_api_key=None, brevo_api_key_file=str(key))), BrevoApiProvider)


def test_the_worker_does_not_build_a_provider_for_a_catcher_in_production():
    with pytest.raises(RuntimeError, match="no usable email configuration"):
        make_provider(settings(email_provider="smtp", smtp_host="mailpit"))


def test_the_api_process_does_not_start_in_production_with_mailpit(monkeypatch):
    import vulnmart.main as main

    monkeypatch.setattr(main, "get_settings", lambda: settings(email_provider="smtp", smtp_host="mailpit"))
    with pytest.raises(RuntimeError, match="no usable email configuration"):
        main.create_entry_app()
    monkeypatch.setattr(main, "get_settings", lambda: settings(env="dev", email_provider="smtp", smtp_host="mailpit"))
    assert main.create_entry_app() is not None  # development keeps Mailpit


# ---- the deployed compose ---------------------------------------------------------------------------------------------

def deployed_blocks() -> list[tuple[str, dict]]:
    compose = yaml.safe_load((ROOT / "infra" / "deploy" / "platform.compose.yaml").read_text(encoding="utf-8"))
    blocks = []
    for name, svc in compose["services"].items():
        env = svc.get("environment")
        if isinstance(env, dict) and env.get("VULNMART_ENV") == "production":
            blocks.append((name, env))
    return blocks


def test_the_rule_accepts_a_deployed_block_that_is_right_and_names_what_is_wrong_in_one_that_is_not():
    right = {"VULNMART_ENV": "production", "VULNMART_EMAIL_PROVIDER": "brevo", "VULNMART_BREVO_API_KEY_FILE": "/run/secrets/brevo_api_key",
             "VULNMART_EMAIL_SENDER_ADDRESS": "no-reply@${VULNMART_PLATFORM_HOST}"}
    assert check_deployed_env(right, key_present=True) == []
    assert check_deployed_env({**right, "VULNMART_EMAIL_PROVIDER": "smtp", "VULNMART_SMTP_HOST": "mailpit"}, key_present=True)
    assert check_deployed_env(right, key_present=False)
    assert check_deployed_env({"VULNMART_ENV": "staging", "VULNMART_EMAIL_PROVIDER": "smtp", "VULNMART_SMTP_HOST": "mailpit"}, key_present=False) == []


def test_the_deployed_compose_does_not_point_at_mailpit_and_names_brevo():
    blocks = deployed_blocks()
    assert blocks, "no production service block found in the deployed compose"
    for name, env in blocks:
        key_present = bool(env.get("VULNMART_BREVO_API_KEY_FILE") or env.get("VULNMART_BREVO_API_KEY"))
        assert check_deployed_env(env, key_present=key_present) == [], f"service {name}: " + "; ".join(check_deployed_env(env, key_present=key_present))
