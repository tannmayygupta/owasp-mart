"""Mail configuration that must be right before the service takes traffic (FR-NTF-03, finding F-03 of the 2026-10-21 wiring audit, LB-1 of the role scenarios).

The deployed stack once ran with `VULNMART_EMAIL_PROVIDER=smtp` and a Mailpit catcher, so no invitation, verification or reset mail reached a person while everything looked fine.
In production the check below fails the start of the API and of the mail worker instead:

- the provider is `brevo` (OI-32, 2026-10-17: Brevo with one verified sender);
- the Brevo API key is present (`VULNMART_BREVO_API_KEY` or the `_FILE` variant);
- the sender address is a real address, not the `.invalid` placeholder, not a localhost or example name;
- Mailpit is forbidden: no SMTP host that names a catcher (`mailpit`, `mailhog`, `localhost`, `127.*`) is allowed, whatever the provider.

`staging` and `dev` keep their freedom (Mailpit is the development tool). `check_deployed_env` applies the same rules to the `VULNMART_*` environment block of a compose file, which
is how the deployment test reads `infra/deploy/platform.compose.yaml` without starting anything.
"""
from __future__ import annotations

import re
from collections.abc import Mapping

from vulnmart.kernel.settings import Settings

CATCHER_HOSTS = ("mailpit", "mailhog", "maildev", "localhost", "127.", "::1")
PLACEHOLDER_DOMAINS = (".invalid", ".example", ".test", ".localhost", "example.com", "example.org", "example.net")
_ADDRESS = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _is_catcher(host: str | None) -> bool:
    return bool(host) and any(marker in host.lower() for marker in CATCHER_HOSTS)


def _sender_problem(address: str | None) -> str | None:
    if not address or not _ADDRESS.match(address):
        return "VULNMART_EMAIL_SENDER_ADDRESS must be a real address (the verified Brevo sender)"
    if address.lower().rsplit("@", 1)[1].endswith(PLACEHOLDER_DOMAINS):
        return "VULNMART_EMAIL_SENDER_ADDRESS is a placeholder; use the verified Brevo sender"
    return None


def problems(provider: str, *, brevo_key: str | None, sender: str | None, smtp_host: str | None) -> list[str]:
    out: list[str] = []
    if provider != "brevo":
        out.append(f"VULNMART_EMAIL_PROVIDER={provider}: production sends through Brevo only (mail to a catcher reaches nobody)")
    if _is_catcher(smtp_host):
        out.append("VULNMART_SMTP_HOST names a mail catcher (Mailpit): it is forbidden in production")
    if provider == "brevo" and not brevo_key:
        out.append("VULNMART_EMAIL_PROVIDER=brevo needs VULNMART_BREVO_API_KEY or VULNMART_BREVO_API_KEY_FILE")
    sender_problem = _sender_problem(sender)
    if sender_problem:
        out.append(sender_problem)
    return out


def validate_mail_settings(settings: Settings) -> None:
    """Raise RuntimeError naming every problem when `VULNMART_ENV=production` has no working real mail. Other environments are not checked."""
    if settings.env != "production":
        return
    found = problems(settings.email_provider, brevo_key=settings.brevo_key_value(), sender=settings.email_sender_address, smtp_host=settings.smtp_host)
    if found:
        raise RuntimeError("VULNMART_ENV=production has no usable email configuration: " + "; ".join(found))


def check_deployed_env(env: Mapping[str, str], *, key_present: bool) -> list[str]:
    """The same rules for an environment block read from a compose file (no secrets in it: `key_present` says whether the deployment supplies the Brevo key, as a secret file
    or a variable). Empty when the block is fine or is not production."""
    if str(env.get("VULNMART_ENV", "")).lower() != "production":
        return []
    return problems(str(env.get("VULNMART_EMAIL_PROVIDER", "smtp")).lower(), brevo_key="present" if key_present else None,
                    sender=re.sub(r"\$\{[^}]*\}", "deploy.vulnmart.app", str(env.get("VULNMART_EMAIL_SENDER_ADDRESS", ""))), smtp_host=env.get("VULNMART_SMTP_HOST"))
