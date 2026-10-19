"""Assessment templates, creating and sending invites, and the invite lifecycle (story P-20, FR-ASM-01, FR-ASM-02, FR-ASM-03).

A recruiter of an active company makes and edits templates inside the company. A recruiter whose company also accepted the data-processing terms invites a
candidate by email to a template: the invite gets a random token (256 bits behind a company prefix, `tokens.py`) kept only as a hash and bound to the
canonical address, the template's rules are copied onto it (so a later edit of the template changes nothing for an invite already sent, FR-ASM-01), the daily
cap of the company is checked and the invite is counted in one transaction under a lock, and the mail goes through the outbox in the same transaction with the
address sealed in the outbox row (the candidate has no account, so there is no user id to look it up from). `sent` is not written by the mail worker: the invite
keeps the id of its queued mail and the state is read from that row, when the invite is read.

Lifecycle (architecture 04 section 10.3): created, sent, opened, consented, started, expired, cancelled, declined, revoked. A recruiter can cancel (before the
mail left), revoke (after), and resend (a new token; the old one is dead). A closed invite stays closed; a re-issue is a new invite. An invite past its expiry is
closed as `expired` the next time anything reads it, and `expire_all` does it for every company (the scheduler of story P-24 calls it). Every change is audited
(the entry never holds the address or the token) and stamped on the invite.

There is no HTTP route yet (IF-1 has none for recruiters, story 5.3). Accepting an invite (opening the link, the consent, the attempt) is story P-21; it uses
`find_by_token` and `advance` below.
"""
from __future__ import annotations

import base64
import logging
import re
import secrets
import unicodedata
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.accounts.security import normalize_email
from vulnmart.accounts.service import InvalidInput
from vulnmart.flags.material import CHALLENGE_KEYS
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.orgs.models import Organization
from vulnmart.orgs.service import CompanyService, NotActiveRecruiter
from vulnmart.ports.attempts import AttemptPort
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, AttemptStateInvalid
from vulnmart.ports.scope import Role, Scope
from vulnmart.ports.settings import SettingsPort

from .models import LIVE_STATES, AssessmentTemplate, Invite, TemplateChallenge
from .tokens import hash_token, new_token, org_of

logger = logging.getLogger("vulnmart.assessments")

Clock = Callable[[], datetime]
TITLE_MAX = 120
RESULTS_VISIBILITY = ("after_submit", "after_release")  # OI-15, the developer's answer of 2026-10-18: a recruiter setting, default right after submit
# The legal moves of an invite (architecture 04 section 10.3). `created -> opened` is also allowed: an invite that is opened was delivered, whether or not the
# state has been read from the mail yet.
EDGES: dict[str, frozenset[str]] = {
    "created": frozenset({"sent", "opened", "cancelled", "expired"}),
    "sent": frozenset({"opened", "expired", "revoked"}),
    "opened": frozenset({"consented", "declined", "expired", "revoked"}),
    "consented": frozenset({"started", "expired", "revoked"}),
}
REINVITABLE = ("started", "consented")  # a re-invite (FR-ASM-05) replaces an attempt that is under way or ready: the fault is the recruiter's judgement call
CLOSED_STATES = ("expired", "cancelled", "declined", "revoked")  # the invite purge empties the token hash of these (a closed invite never opens again)
BULK_MAX = 500
STAMPS = {"sent": "sent_at", "opened": "opened_at", "consented": "consented_at", "started": "started_at", "expired": "closed_at", "cancelled": "closed_at",
          "declined": "closed_at", "revoked": "closed_at"}
# What a template can never switch off (FR-ASM-01): asking to is refused by name.
FIXED_ON = frozenset({"flags", "flags_enabled", "per_instance_flags", "evidence", "evidence_capture", "audit", "audit_log", "consent", "consent_screen"})
TEMPLATE_FIELDS = frozenset({"title", "challenge_keys", "time_limit_min", "hints_mode", "hint_cost_pct", "reset_limit", "invite_expiry_days", "retention_days",
                             "writeup_required", "results_visibility", "flag_submissions_per_minute"})
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
_SPACE = re.compile(r"\s+")


def utc_now() -> datetime:
    return datetime.now(UTC)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class TemplateNotFound(Exception):
    """No such template in the company."""


class InviteNotFound(Exception):
    """No such invite in the company."""


class InviteExists(Exception):
    """A live invite for this template and address already exists (resend it, or revoke it first)."""


class InviteClosed(Exception):
    """The invite is in a state this change does not start from. `state` is the state it is in."""

    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


class InviteCapReached(Exception):
    """The company's daily invite cap is used up; nothing was made and the recruiter's other invites are untouched."""

    def __init__(self, cap: int, remaining: int):
        super().__init__(cap)
        self.cap, self.remaining = cap, remaining


class TemplateInUse(Exception):
    """A template with invites cannot be deleted."""


class AlreadyStarted(Exception):
    """The candidate already started an attempt on this template: a new invite would be a second attempt, which only a re-invite may grant (FR-ASM-05)."""


class InviteTaken(Exception):
    """The invite is already bound to another account."""


@dataclass(frozen=True, slots=True)
class TemplateView:
    template_id: str
    title: str
    challenge_keys: tuple[str, ...]
    time_limit_min: int
    hints_mode: str
    hint_cost_pct: int
    reset_limit: int
    invite_expiry_days: int
    retention_days: int
    writeup_required: bool
    results_visibility: str
    flag_submissions_per_minute: int
    version: int
    updated_at: datetime

    def rules(self) -> dict[str, Any]:
        """The rules an invite copies and an attempt runs under."""
        return {"challenge_keys": list(self.challenge_keys), "time_limit_min": self.time_limit_min, "hints_mode": self.hints_mode,
                "hint_cost_pct": self.hint_cost_pct, "reset_limit": self.reset_limit, "invite_expiry_days": self.invite_expiry_days,
                "retention_days": self.retention_days, "writeup_required": self.writeup_required, "results_visibility": self.results_visibility,
                "flag_submissions_per_minute": self.flag_submissions_per_minute, "template_version": self.version}


@dataclass(frozen=True, slots=True)
class InviteView:
    invite_id: str
    template_id: str
    email: str
    state: str
    expires_at: datetime
    created_at: datetime
    sent_at: datetime | None
    opened_at: datetime | None
    consented_at: datetime | None
    started_at: datetime | None
    closed_at: datetime | None
    rules: Mapping[str, Any]
    user_id: str | None = None  # the candidate account the invite is bound to (story P-21)
    attempt_id: str | None = None  # the id the attempt has or will have
    generation: int = 1  # 2, 3 ... for each re-invite
    supersedes_attempt_id: str | None = None
    superseded_by: str | None = None


@dataclass(frozen=True, slots=True)
class RetentionInvite:
    """What the retention job needs to know about an invite: whose record it is, which attempt, how long the template said to keep it, and since when."""
    invite_id: str
    org_id: str
    state: str
    attempt_id: str | None
    user_id: str | None
    created_at: datetime
    retention_days: int | None


@dataclass(frozen=True, slots=True)
class BulkResult:
    """What a bulk invite did, address by address (FR-ASM-06). `skipped` pairs an address with why: `invalid`, `duplicate` (twice in the list), `exists` (a live invite
    for it), `started` (it already has an attempt: use a re-invite). `remaining` is what was not tried because the company's daily cap ran out, in the order given, so
    nothing is lost: send it again tomorrow. `cap` is the cap that stopped it (None if nothing did)."""
    created: tuple[InviteView, ...]
    skipped: tuple[tuple[str, str], ...]
    remaining: tuple[str, ...]
    cap: int | None = None


def _clean_title(raw: Any) -> str:
    if not isinstance(raw, str):
        raise InvalidInput("/title")
    title = _SPACE.sub(" ", _CONTROL.sub(" ", unicodedata.normalize("NFC", raw))).strip()
    if not 1 <= len(title) <= TITLE_MAX:
        raise InvalidInput("/title")
    return title


def _int(values: Mapping[str, Any], name: str, default: int, low: int, high: int) -> int:
    value = values.get(name, default)
    if type(value) is not int or not low <= value <= high:
        raise InvalidInput(f"/{name}", "out_of_range")
    return value


def validate_template(values: Mapping[str, Any], *, default_retention: int = 180) -> dict[str, Any]:
    """Check a template's fields and fill in the defaults (FR-ASM-01): title; any of the 11 challenges (at least one); time limit 30 to 480 minutes (default 120);
    hints off (default) or on with a cost of 0 to 100 percent; resets 0 to 10 (default 3); flag submissions 1 to 60 a minute (default 10); invite expiry 1 to 30
    days (default 7); retention 30 to 365 days; a write-up required or optional (default optional, OI-14); when the candidate sees results (default right after
    submit, OI-15). Anything else is refused by name, and the things that can never be switched off are refused as such. The numeric ranges are the research
    placeholders of OI-25."""
    for key in values:
        if key in FIXED_ON:
            raise InvalidInput(f"/{key}", "cannot_be_switched_off")
        if key not in TEMPLATE_FIELDS:
            raise InvalidInput(f"/{key}", "unknown_member")
    keys = values.get("challenge_keys")
    if not isinstance(keys, (list, tuple)) or not keys or len(set(keys)) != len(keys) or any(k not in CHALLENGE_KEYS for k in keys):
        raise InvalidInput("/challenge_keys", "unknown_challenge")
    hints_mode = values.get("hints_mode", "off")
    if hints_mode not in ("off", "on"):
        raise InvalidInput("/hints_mode")
    cost = values.get("hint_cost_pct", 0 if hints_mode == "off" else 20)
    if type(cost) is not int or not 0 <= cost <= 100 or (hints_mode == "off" and cost != 0):
        raise InvalidInput("/hint_cost_pct", "out_of_range")
    writeup = values.get("writeup_required", False)
    visibility = values.get("results_visibility", "after_submit")
    if type(writeup) is not bool:
        raise InvalidInput("/writeup_required")
    if visibility not in RESULTS_VISIBILITY:
        raise InvalidInput("/results_visibility")
    return {
        "title": _clean_title(values.get("title")), "challenge_keys": sorted(keys), "hints_mode": hints_mode, "hint_cost_pct": cost,
        "time_limit_min": _int(values, "time_limit_min", 120, 30, 480), "reset_limit": _int(values, "reset_limit", 3, 0, 10),
        "invite_expiry_days": _int(values, "invite_expiry_days", 7, 1, 30), "retention_days": _int(values, "retention_days", default_retention, 30, 365),
        "flag_submissions_per_minute": _int(values, "flag_submissions_per_minute", 10, 1, 60), "writeup_required": writeup, "results_visibility": visibility,
    }


def new_attempt_id() -> str:
    """The id an attempt will have (the lab's own ids look the same: `a-` and 16 Base32 characters), given out when an invite is bound so the consent record can name it."""
    return "a-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def new_invite_id() -> str:
    import base64
    import secrets

    return "i-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


class AssessmentService:
    def __init__(self, sessions: sessionmaker[Session], companies: CompanyService, audit: AuditPort, scope: ContextScopePort, settings: SettingsPort,
                 keys: FieldKeys, *, public_origin: str, now: Clock = utc_now, attempts: AttemptPort | None = None):
        self._sessions, self._companies, self._audit, self._scope, self._settings = sessions, companies, audit, scope, settings
        self._keys, self._origin, self._now, self._attempts = keys, public_origin.rstrip("/"), now, attempts

    # ---- who is calling ----

    def _recruiter_org(self, actor: Scope, *, for_invites: bool = False) -> uuid.UUID:
        """The company of a recruiter's scope, after checking that it is the company they are an active recruiter of (and, for invites, that it accepted the terms)."""
        if actor.org_id is None or Role.RECRUITER not in actor.roles:
            raise NotActiveRecruiter("none")
        org = self._companies.invite_company_of(actor.user_id) if for_invites else self._companies.active_company_of(actor.user_id)
        if org != str(actor.org_id):
            raise NotActiveRecruiter("none")
        return uuid.UUID(org)

    def _system(self, org_id: uuid.UUID) -> Scope:
        return Scope(user_id="system:invites", org_id=str(org_id), roles=frozenset({Role.RECRUITER}))

    # ---- templates (FR-ASM-01) ----

    def _view(self, row: AssessmentTemplate, keys: list[str]) -> TemplateView:
        s = dict(row.settings or {})
        return TemplateView(str(row.id), row.title, tuple(sorted(keys)), row.time_limit_min, row.hints_mode, row.hint_cost_pct, row.reset_limit, row.invite_expiry_days,
                            row.retention_days, bool(s.get("writeup_required", False)), s.get("results_visibility", "after_submit"),
                            int(s.get("flag_submissions_per_minute", 10)), row.version, _aware(row.updated_at))

    def _write_template(self, session: Session, row: AssessmentTemplate, fields: dict[str, Any]) -> None:
        row.title, row.time_limit_min, row.hints_mode, row.hint_cost_pct = fields["title"], fields["time_limit_min"], fields["hints_mode"], fields["hint_cost_pct"]
        row.reset_limit, row.invite_expiry_days, row.retention_days = fields["reset_limit"], fields["invite_expiry_days"], fields["retention_days"]
        row.settings = {"writeup_required": fields["writeup_required"], "results_visibility": fields["results_visibility"],
                        "flag_submissions_per_minute": fields["flag_submissions_per_minute"]}

    def create_template(self, actor: Scope, values: Mapping[str, Any]) -> TemplateView:
        org = self._recruiter_org(actor)
        fields = validate_template(values, default_retention=int(self._settings.get("candidate_retention_days")))
        now = self._now()
        with self._scope.acting_as(actor):
            with self._sessions.begin() as session:
                row = AssessmentTemplate(id=uuid.uuid4(), org_id=org, version=1, created_by=actor.user_id, created_at=now, updated_at=now)
                self._write_template(session, row, fields)
                session.add(row)
                session.flush()
                for key in fields["challenge_keys"]:
                    session.add(TemplateChallenge(template_id=row.id, challenge_key=key, org_id=org))
                self._audit.append(actor=actor.user_id, action="template.created", subject=actor.user_id, details={"org": str(org), "template": str(row.id)})
                return self._view(row, fields["challenge_keys"])

    def update_template(self, actor: Scope, template_id: str, values: Mapping[str, Any]) -> TemplateView:
        """Replace a template's fields (an edit raises its version). Invites already made keep the rules they were made with."""
        org = self._recruiter_org(actor)
        tid = self._uuid(template_id, TemplateNotFound)
        fields = validate_template(values, default_retention=int(self._settings.get("candidate_retention_days")))
        with self._scope.acting_as(actor):
            with self._sessions.begin() as session:
                row = session.get(AssessmentTemplate, tid)
                if row is None:
                    raise TemplateNotFound
                self._write_template(session, row, fields)
                row.version, row.updated_at = row.version + 1, self._now()
                session.execute(delete(TemplateChallenge).where(TemplateChallenge.template_id == tid))
                session.flush()
                for key in fields["challenge_keys"]:
                    session.add(TemplateChallenge(template_id=tid, challenge_key=key, org_id=org))
                self._audit.append(actor=actor.user_id, action="template.updated", subject=actor.user_id,
                                   details={"org": str(org), "template": str(tid), "version": row.version})
                return self._view(row, fields["challenge_keys"])

    def get_template(self, actor: Scope, template_id: str) -> TemplateView:
        self._recruiter_org(actor)
        tid = self._uuid(template_id, TemplateNotFound)
        with self._scope.acting_as(actor):
            with self._sessions() as session:
                row = session.get(AssessmentTemplate, tid)
                if row is None:
                    raise TemplateNotFound
                return self._view(row, list(session.scalars(select(TemplateChallenge.challenge_key).where(TemplateChallenge.template_id == tid))))

    def list_templates(self, actor: Scope, limit: int = 100) -> list[TemplateView]:
        self._recruiter_org(actor)
        with self._scope.acting_as(actor):
            with self._sessions() as session:
                rows = session.scalars(select(AssessmentTemplate).order_by(AssessmentTemplate.created_at, AssessmentTemplate.id).limit(max(1, min(limit, 500)))).all()
                keys: dict[uuid.UUID, list[str]] = {}
                for tid, key in session.execute(select(TemplateChallenge.template_id, TemplateChallenge.challenge_key)):
                    keys.setdefault(tid, []).append(key)
                return [self._view(r, keys.get(r.id, [])) for r in rows]

    def delete_template(self, actor: Scope, template_id: str) -> None:
        org = self._recruiter_org(actor)
        tid = self._uuid(template_id, TemplateNotFound)
        with self._scope.acting_as(actor):
            with self._sessions.begin() as session:
                if session.get(AssessmentTemplate, tid) is None:
                    raise TemplateNotFound
                if session.scalar(select(func.count()).select_from(Invite).where(Invite.template_id == tid)):
                    raise TemplateInUse  # invites keep their own copy of the rules, but the record of what they were for stays
                session.execute(delete(AssessmentTemplate).where(AssessmentTemplate.id == tid))
                self._audit.append(actor=actor.user_id, action="template.deleted", subject=actor.user_id, details={"org": str(org), "template": str(tid)})

    # ---- invites (FR-ASM-02) ----

    def create_invite(self, actor: Scope, template_id: str, email: str) -> InviteView:
        """Invite a candidate by email. Needs an active recruiter of a company that accepted the terms, a free place under the daily cap and no live invite for the
        same template and address. Raises InvalidInput (`/email`), TemplateNotFound, InviteExists, AlreadyStarted (use a re-invite), InviteCapReached,
        NotActiveRecruiter, TermsNotAccepted."""
        return self._create(actor, template_id, email)

    def _create(self, actor: Scope, template_id: str, email: str, *, generation: int = 1, supersedes: str | None = None) -> InviteView:
        """`supersedes` is the id of the invite a re-invite replaces: it is marked and (if consented) revoked in the same transaction as the new invite is made, so a
        refusal (the cap, a duplicate) leaves the old one exactly as it was."""
        org = self._recruiter_org(actor, for_invites=True)
        tid = self._uuid(template_id, TemplateNotFound)
        email_ci = normalize_email(email)
        if email_ci is None:
            raise InvalidInput("/email")
        now = self._now()
        token = new_token(org)
        invite_id = new_invite_id()
        with self._scope.acting_as(actor):
            self._expire_duplicates(tid, email_ci, now)  # a transaction of its own: a live invite past its expiry is closed for good, whatever happens next
            with self._sessions.begin() as session:
                if session.get_bind().dialect.name == "postgresql":  # one creator at a time per company: the count and the insert below must not interleave
                    session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"invites:{org}"})
                template = session.get(AssessmentTemplate, tid)
                company = session.get(Organization, org)
                if template is None or company is None:
                    raise TemplateNotFound
                day_start = datetime.combine(now.astimezone(UTC).date(), datetime.min.time(), tzinfo=UTC)
                sent_today = session.scalar(select(func.count()).select_from(Invite).where(Invite.created_at >= day_start)) or 0
                decision = self._companies.check_invite_cap(str(org), sent_today)
                if not decision.allowed:
                    raise InviteCapReached(decision.cap, decision.remaining)
                keys = list(session.scalars(select(TemplateChallenge.challenge_key).where(TemplateChallenge.template_id == tid)))
                view = self._view(template, keys)
                old_attempt: str | None = None
                if supersedes is not None:
                    old = session.get(Invite, supersedes)
                    if old is None or old.org_id != org or old.template_id != tid or old.email_ci != email_ci:
                        raise InviteNotFound
                    if old.state not in REINVITABLE or old.attempt_id is None or old.superseded_by is not None:
                        raise InviteClosed(old.state)
                    values: dict[str, Any] = {"superseded_by": invite_id}
                    if old.state == "consented":
                        values.update(state="revoked", closed_at=now)  # the link of a consented invite must not start a second attempt next to the new one
                    if session.execute(update(Invite).where(Invite.id == old.id, Invite.state == old.state, Invite.superseded_by.is_(None)).values(**values)).rowcount != 1:
                        raise InviteClosed(session.scalar(select(Invite.state).where(Invite.id == old.id)) or old.state)
                    old_attempt = old.attempt_id
                    self._audit.append(actor=actor.user_id, action="invite.superseded", subject=None,
                                       details={"org": str(org), "invite": old.id, "replaced_by": invite_id})
                if session.scalar(select(Invite.id).where(Invite.template_id == tid, Invite.email_ci == email_ci, Invite.state.in_(LIVE_STATES))) is not None:
                    raise InviteExists
                if supersedes is None and session.scalar(select(Invite.id).where(Invite.template_id == tid, Invite.email_ci == email_ci, Invite.state == "started")) is not None:
                    raise AlreadyStarted
                invite = Invite(id=invite_id, org_id=org, template_id=tid, template_version=template.version, rules=view.rules(), email_ci=email_ci,
                                token_hash=hash_token(token), state="created", expires_at=now + timedelta(days=template.invite_expiry_days),
                                created_by=actor.user_id, created_at=now, generation=generation, supersedes_attempt_id=old_attempt)
                try:
                    with session.begin_nested():
                        session.add(invite)
                        session.flush()
                except IntegrityError:
                    raise InviteExists from None
                invite.outbox_id = self._queue_mail(session, invite, company.name, template.title, token).id
                self._audit.append(actor=actor.user_id, action="invite.created", subject=None, details={"org": str(org), "invite": invite_id, "template": str(tid)})
                return self._invite_view(invite)

    def create_invites(self, actor: Scope, template_id: str, emails: list[str]) -> BulkResult:
        """Invite many candidates to one template (FR-ASM-06). Each address is its own invite with its own token, mail and place under the daily cap; a bad one does not stop
        the rest. At the cap it stops and hands back the addresses it did not reach. The provider's daily sending cap is separate: it delays the mail (the outbox sends them in
        order over the following days), the invites exist at once. Raises InvalidInput (`/emails`) for an empty list or more than 500, and what `create_invite` raises
        for the caller or the template (NotActiveRecruiter, TermsNotAccepted, TemplateNotFound)."""
        if not isinstance(emails, (list, tuple)) or not emails or len(emails) > BULK_MAX or not all(isinstance(e, str) for e in emails):
            raise InvalidInput("/emails")
        created: list[InviteView] = []
        skipped: list[tuple[str, str]] = []
        seen: set[str] = set()
        for position, raw in enumerate(emails):
            canonical = normalize_email(raw)
            if canonical is None:
                skipped.append((raw, "invalid"))
                continue
            if canonical in seen:
                skipped.append((raw, "duplicate"))
                continue
            seen.add(canonical)
            try:
                created.append(self._create(actor, template_id, raw))
            except InviteExists:
                skipped.append((raw, "exists"))
            except AlreadyStarted:
                skipped.append((raw, "started"))
            except InviteCapReached as stop:
                rest: list[str] = []
                later = seen - {canonical}  # what was already made or skipped is not "remaining"
                for pending in emails[position:]:
                    key = normalize_email(pending)
                    if key is not None and key not in later:
                        later.add(key)
                        rest.append(pending)
                return BulkResult(tuple(created), tuple(skipped), tuple(rest), stop.cap)
        return BulkResult(tuple(created), tuple(skipped), ())

    def reinvite(self, actor: Scope, invite_id: str) -> InviteView:
        """A fault happened (FR-ASM-05): give the candidate a new attempt. Only for an invite that was consented to or started. The new invite has the next `generation`,
        names the old attempt in `supersedes_attempt_id` and gets the template's rules as they are now; the old invite is marked `superseded_by` (and revoked if it was only
        consented), and the old attempt is cancelled through the lab port when it can be (a running or ready attempt; one that cannot be cancelled is left, and logged).
        The new invite counts against the daily cap. Raises InviteNotFound, InviteClosed(state), InviteCapReached, TermsNotAccepted, NotActiveRecruiter."""
        org = self._recruiter_org(actor, for_invites=True)
        with self._scope.acting_as(actor):
            self._settle(invite_id)
            with self._sessions() as session:
                old = self._own_invite(session, org, invite_id)
                if old.state not in REINVITABLE or old.attempt_id is None or old.superseded_by is not None:
                    raise InviteClosed(old.state)
                template_id, email, generation, old_attempt = str(old.template_id), old.email_ci, old.generation, old.attempt_id
        fresh = self._create(actor, template_id, email, generation=generation + 1, supersedes=invite_id)
        if self._attempts is not None:
            try:
                self._attempts.cancel(old_attempt, by=actor.user_id)
            except (AttemptNotFound, AttemptGone, AttemptStateInvalid) as why:
                logger.warning("re-invite %s: the old attempt %s was not cancelled (%s)", fresh.invite_id, old_attempt, type(why).__name__)
        return fresh

    def _expire_duplicates(self, tid: uuid.UUID, email_ci: str, now: datetime) -> None:
        """Close the live invite for this template and address if it is already past its expiry, so that it does not block a new one."""
        with self._sessions.begin() as session:
            for old in session.scalars(select(Invite).where(Invite.template_id == tid, Invite.email_ci == email_ci, Invite.state.in_(LIVE_STATES))).all():
                if _aware(old.expires_at) <= now:
                    self._close(session, old, "expired", now)

    def _queue_mail(self, session: Session, invite: Invite, org_name: str, assessment_name: str, token: str):
        days = max(1, int(round((_aware(invite.expires_at) - self._now()).total_seconds() / 86400)))
        outbox = DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params,
                              address_sealer=lambda address, aad: self._keys.seal(address, account=aad))
        return outbox.enqueue_email(template="candidate.invite", to_user_id=invite.id, to_address=invite.email_ci,
                                    params={"org_name": org_name, "assessment_name": assessment_name, "link": f"{self._origin}/invite?token={token}",
                                            "expires_in_days": days})

    # ---- reading, with the lazy parts ----

    def list_invites(self, actor: Scope, *, state: str | None = None, template_id: str | None = None, limit: int = 100) -> list[InviteView]:
        org = self._recruiter_org(actor)
        now = self._now()
        with self._scope.acting_as(actor):
            with self._sessions.begin() as session:
                query = select(Invite).where(Invite.org_id == org).order_by(Invite.created_at.desc(), Invite.id).limit(max(1, min(limit, 500)))
                if template_id is not None:
                    query = query.where(Invite.template_id == self._uuid(template_id, TemplateNotFound))
                rows = session.scalars(query).all()
                self._refresh(session, rows, now)
                return [self._invite_view(r) for r in rows if state is None or r.state == state]

    def get_invite(self, actor: Scope, invite_id: str) -> InviteView:
        org = self._recruiter_org(actor)
        with self._scope.acting_as(actor):
            with self._sessions.begin() as session:
                invite = session.get(Invite, invite_id)
                if invite is None or invite.org_id != org:
                    raise InviteNotFound
                self._refresh(session, [invite], self._now())
                return self._invite_view(invite)

    def _refresh(self, session: Session, invites: list[Invite], now: datetime) -> None:
        """Read `sent` from the queued mail and close what is past its expiry. Called inside a transaction, wherever invites are read. Each change is a conditional
        UPDATE on the state it starts from (never an unconditional write of what was read a moment ago), so it cannot undo a move another request made meanwhile;
        the invite is read again afterwards, so the caller goes on from what the database says."""
        waiting = [i for i in invites if i.state == "created" and i.outbox_id is not None]
        sent: dict[int, datetime | None] = {}
        if waiting:
            sent = {r.id: r.sent_at for r in session.execute(select(EmailOutbox.id, EmailOutbox.sent_at).where(
                EmailOutbox.id.in_([i.outbox_id for i in waiting]), EmailOutbox.state == "sent"))}
        for invite in invites:
            moved = False
            if invite.state == "created" and invite.outbox_id in sent:
                became_sent = session.execute(update(Invite).where(Invite.id == invite.id, Invite.state == "created", Invite.outbox_id == invite.outbox_id)
                                              .values(state="sent", sent_at=sent[invite.outbox_id] or now).execution_options(synchronize_session=False)).rowcount == 1
                if became_sent:
                    self._audit.append(actor="system:invites", action="invite.sent", subject=None, details={"org": str(invite.org_id), "invite": invite.id})
                moved |= became_sent
            if invite.state in LIVE_STATES and invite.state != "started" and _aware(invite.expires_at) <= now:
                moved |= self._close(session, invite, "expired", now)
            if moved:
                session.refresh(invite)

    def _close(self, session: Session, invite: Invite, state: str, now: datetime) -> bool:
        """Close a live invite (conditional on it still being live and past its expiry for `expired`). True when this call did it; the audit entry only then."""
        condition = [Invite.id == invite.id, Invite.state.in_(LIVE_STATES)]
        if state == "expired":
            condition.append(Invite.expires_at <= now)
        done = session.execute(update(Invite).where(*condition).values(state=state, closed_at=now).execution_options(synchronize_session=False)).rowcount == 1
        if done:
            self._audit.append(actor="system:invites", action=f"invite.{state}", subject=None, details={"org": str(invite.org_id), "invite": invite.id})
        return done

    @staticmethod
    def _invite_view(invite: Invite) -> InviteView:
        def when(value: datetime | None) -> datetime | None:
            return None if value is None else _aware(value)

        return InviteView(invite.id, str(invite.template_id), invite.email_ci, invite.state, _aware(invite.expires_at), _aware(invite.created_at), when(invite.sent_at),
                          when(invite.opened_at), when(invite.consented_at), when(invite.started_at), when(invite.closed_at), dict(invite.rules or {}),
                          invite.user_id, invite.attempt_id, invite.generation, invite.supersedes_attempt_id, invite.superseded_by)

    @staticmethod
    def _uuid(value: str, error: type[Exception]) -> uuid.UUID:
        try:
            return uuid.UUID(str(value))
        except ValueError:
            raise error from None

    # ---- what a recruiter does with an invite (FR-ASM-03) ----

    def _settle(self, invite_id: str) -> None:
        """Bring `sent` and the expiry of one invite up to date in a transaction of its own, before a change that may be refused. Doing it inside the change would
        roll it back with the refusal (and repeat its audit entry each time): a refused resend of an expired invite must still leave it closed, once."""
        now = self._now()
        with self._sessions.begin() as session:
            invite = session.get(Invite, invite_id)
            if invite is not None:
                self._refresh(session, [invite], now)

    def _own_invite(self, session: Session, org: uuid.UUID, invite_id: str) -> Invite:
        invite = session.get(Invite, invite_id)
        if invite is None or invite.org_id != org:
            raise InviteNotFound
        return invite

    def cancel(self, actor: Scope, invite_id: str) -> InviteView:
        """created -> cancelled: the mail has not been seen to leave yet. After that, `revoke`."""
        return self._recruiter_close(actor, invite_id, from_states=("created",), to_state="cancelled")

    def revoke(self, actor: Scope, invite_id: str) -> InviteView:
        """sent, opened or consented -> revoked: the link stops working."""
        return self._recruiter_close(actor, invite_id, from_states=("sent", "opened", "consented"), to_state="revoked")

    def _recruiter_close(self, actor: Scope, invite_id: str, *, from_states: tuple[str, ...], to_state: str) -> InviteView:
        org = self._recruiter_org(actor)
        now = self._now()
        with self._scope.acting_as(actor):
            self._settle(invite_id)
            with self._sessions.begin() as session:
                invite = self._own_invite(session, org, invite_id)
                if invite.state not in from_states:
                    raise InviteClosed(invite.state)
                changed = session.execute(update(Invite).where(Invite.id == invite_id, Invite.state == invite.state)
                                          .values(state=to_state, closed_at=now)).rowcount
                if changed != 1:
                    raise InviteClosed(session.scalar(select(Invite.state).where(Invite.id == invite_id)) or invite.state)
                self._audit.append(actor=actor.user_id, action=f"invite.{to_state}", subject=None, details={"org": str(org), "invite": invite_id})
                session.refresh(invite)
                return self._invite_view(invite)

    def resend(self, actor: Scope, invite_id: str) -> InviteView:
        """A new token and a new mail; the old token is dead at once (FR-ASM-03). Only for an invite not yet consented to; the state goes back to `created`
        and the expiry starts again from the template's days at the time the invite was made."""
        org = self._recruiter_org(actor, for_invites=True)
        now = self._now()
        token = new_token(org)
        with self._scope.acting_as(actor):
            self._settle(invite_id)
            with self._sessions.begin() as session:
                invite = self._own_invite(session, org, invite_id)
                if invite.state not in ("created", "sent", "opened"):
                    raise InviteClosed(invite.state)
                company = session.get(Organization, org)
                template = session.get(AssessmentTemplate, invite.template_id)
                days = int((invite.rules or {}).get("invite_expiry_days", template.invite_expiry_days if template else 7))
                changed = session.execute(update(Invite).where(Invite.id == invite_id, Invite.state == invite.state).values(
                    token_hash=hash_token(token), state="created", sent_at=None, opened_at=None, expires_at=now + timedelta(days=days))).rowcount
                if changed != 1:
                    raise InviteClosed(session.scalar(select(Invite.state).where(Invite.id == invite_id)) or invite.state)
                session.refresh(invite)
                title = template.title if template else str((invite.rules or {}).get("title", "assessment"))
                invite.outbox_id = self._queue_mail(session, invite, company.name, title, token).id
                self._audit.append(actor=actor.user_id, action="invite.resent", subject=None, details={"org": str(org), "invite": invite_id})
                return self._invite_view(invite)

    # ---- for the accepting story (P-21) and the scheduler (P-24) ----

    def find_by_token(self, token: str) -> InviteView | None:
        """The invite a token opens, or None (malformed, unknown, dead, or past its expiry: an expired invite is closed on the way and returned as `expired`).
        The candidate has no session, so the company in the token's prefix is put in scope for the lookup."""
        org = org_of(token)
        if org is None:
            return None
        now = self._now()
        with self._scope.acting_as(self._system(org)):
            with self._sessions.begin() as session:
                invite = session.scalar(select(Invite).where(Invite.token_hash == hash_token(token)))
                if invite is None:
                    return None
                self._refresh(session, [invite], now)
                return self._invite_view(invite)

    def advance(self, org_id: str, invite_id: str, to_state: str) -> InviteView:
        """Move an invite along its lifecycle (the accepting story uses it for opened, consented, declined and started). Only the legal moves; InviteClosed(state)
        otherwise. Each move is stamped on the invite and audited."""
        oid = self._uuid(org_id, InviteNotFound)
        now = self._now()
        with self._scope.acting_as(self._system(oid)):
            self._settle(invite_id)
            with self._sessions.begin() as session:
                invite = session.get(Invite, invite_id)
                if invite is None:
                    raise InviteNotFound
                if to_state not in EDGES.get(invite.state, frozenset()):
                    raise InviteClosed(invite.state)
                values: dict[str, Any] = {"state": to_state, STAMPS[to_state]: now}
                if invite.state == "created" and to_state == "opened":
                    values["sent_at"] = invite.sent_at or now  # opened means it was delivered
                changed = session.execute(update(Invite).where(Invite.id == invite_id, Invite.state == invite.state).values(**values)).rowcount
                if changed != 1:
                    raise InviteClosed(session.scalar(select(Invite.state).where(Invite.id == invite_id)) or invite.state)
                self._audit.append(actor="system:invites", action=f"invite.{to_state}", subject=None, details={"org": str(oid), "invite": invite_id})
                session.refresh(invite)
                return self._invite_view(invite)

    def bind_candidate(self, org_id: str, invite_id: str, user_id: str) -> InviteView:
        """Bind an opened invite to the candidate whose verified address matched (the caller has checked that): sets `user_id` and gives out the `attempt_id` the consent
        record will name. One conditional UPDATE, so two accounts cannot both bind. The same account again is a no-op returning the invite; another account is InviteTaken;
        an invite that is not open (or consented) is InviteClosed(state)."""
        oid = self._uuid(org_id, InviteNotFound)
        with self._scope.acting_as(self._system(oid)):
            self._settle(invite_id)
            with self._sessions.begin() as session:
                invite = session.get(Invite, invite_id)
                if invite is None:
                    raise InviteNotFound
                if invite.state not in ("opened", "consented"):
                    raise InviteClosed(invite.state)
                if invite.user_id is not None:
                    if invite.user_id != user_id:
                        raise InviteTaken
                    return self._invite_view(invite)
                changed = session.execute(update(Invite).where(Invite.id == invite_id, Invite.user_id.is_(None), Invite.state.in_(("opened", "consented")))
                                          .values(user_id=user_id, attempt_id=new_attempt_id())).rowcount
                session.refresh(invite)
                if changed != 1:
                    if invite.user_id == user_id:
                        return self._invite_view(invite)
                    raise InviteTaken if invite.user_id is not None else InviteClosed(invite.state)
                self._audit.append(actor=user_id, action="invite.bound", subject=user_id, details={"org": str(oid), "invite": invite_id, "attempt": invite.attempt_id})
                return self._invite_view(invite)

    def for_attempt(self, attempt_id: str) -> tuple[InviteView, str, str] | None:
        """The invite that names this attempt, the id of its company and the company's name, read in the scope of the running request: a signed-in candidate sees only the invite bound to them
        (policy `own_invite`), anyone else, and a request with no scope, gets None. The company name is read in the company's own scope."""
        with self._sessions() as session:
            invite = session.scalar(select(Invite).where(Invite.attempt_id == attempt_id))
            if invite is None:
                return None
            view, org = self._invite_view(invite), invite.org_id
        with self._scope.acting_as(self._system(org)):
            with self._sessions() as session:
                company = session.get(Organization, org)
                return None if company is None else (view, str(org), company.name)

    def purge_closed_tokens(self, before: datetime) -> int:
        """Empty the token hash of every closed invite (expired, cancelled, declined, revoked) that closed at or before `before` (the invite purge of story P-24 calls
        it; the retention rule decides `before`). The invite row stays, without a token nobody can open it. Returns how many."""
        with self._scope.acting_as(Scope(user_id="system:invites", roles=frozenset({Role.ADMIN}))):
            with self._sessions() as session:
                orgs = [o for o in session.scalars(select(Organization.id))]
        total = 0
        for org in orgs:
            with self._scope.acting_as(self._system(org)):
                with self._sessions.begin() as session:
                    total += session.execute(update(Invite).where(Invite.org_id == org, Invite.state.in_(CLOSED_STATES), Invite.token_hash.is_not(None),
                                                                  Invite.closed_at <= before).values(token_hash=None)).rowcount
        return total

    def retention_invites(self, created_before: datetime, *, limit: int = 500) -> list[RetentionInvite]:
        """The invites of every company made at or before `created_before`, oldest first (the retention job of story P-24 decides which are due: that depends on the
        attempt). The companies are read through the admin-visible directory, each one's invites in its own scope."""
        with self._scope.acting_as(Scope(user_id="system:invites", roles=frozenset({Role.ADMIN}))):
            with self._sessions() as session:
                orgs = [o for o in session.scalars(select(Organization.id))]
        found: list[RetentionInvite] = []
        for org in orgs:
            with self._scope.acting_as(self._system(org)):
                with self._sessions() as session:
                    rows = session.scalars(select(Invite).where(Invite.org_id == org, Invite.created_at <= created_before).order_by(Invite.created_at).limit(limit)).all()
                    for r in rows:
                        days = (r.rules or {}).get("retention_days")
                        found.append(RetentionInvite(r.id, str(org), r.state, r.attempt_id, r.user_id, _aware(r.created_at), int(days) if isinstance(days, int) else None))
        found.sort(key=lambda i: i.created_at)
        return found[:limit]

    def delete_invites(self, org_id: str, invite_ids: list[str]) -> int:
        """Delete invites of one company (the retention job: the candidate's record is gone). Returns how many were deleted."""
        oid = self._uuid(org_id, InviteNotFound)
        if not invite_ids:
            return 0
        with self._scope.acting_as(self._system(oid)):
            with self._sessions.begin() as session:
                return session.execute(delete(Invite).where(Invite.org_id == oid, Invite.id.in_(invite_ids))).rowcount

    def delete_attempt_invite(self, org_id: str, attempt_id: str) -> int:
        """Delete the invite of one company that names this attempt (an early deletion, story P-25: the person's request approved, or the company deleting). 0 when there is none."""
        oid = self._uuid(org_id, InviteNotFound)
        with self._scope.acting_as(self._system(oid)):
            with self._sessions.begin() as session:
                return session.execute(delete(Invite).where(Invite.org_id == oid, Invite.attempt_id == attempt_id)).rowcount

    def expire_due(self, org_id: str) -> int:
        """Close the live invites of one company that are past their expiry. Returns how many."""
        oid = self._uuid(org_id, InviteNotFound)
        now = self._now()
        with self._scope.acting_as(self._system(oid)):
            with self._sessions.begin() as session:
                rows = session.scalars(select(Invite).where(Invite.org_id == oid, Invite.state.in_(("created", "sent", "opened", "consented")),
                                                            Invite.expires_at <= now)).all()
                return sum(1 for invite in rows if self._close(session, invite, "expired", now))

    def expire_all(self) -> int:
        """`expire_due` for every company (the scheduler of story P-24 calls it). The companies are read through the admin-visible company directory."""
        with self._scope.acting_as(Scope(user_id="system:invites", roles=frozenset({Role.ADMIN}))):
            with self._sessions() as session:
                orgs = [str(o) for o in session.scalars(select(Organization.id))]
        return sum(self.expire_due(o) for o in orgs)
