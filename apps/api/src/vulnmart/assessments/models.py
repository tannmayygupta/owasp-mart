"""Assessment tables (architecture 04 section 2.4; owner `assessments` in contracts/db/table-owners.yaml): templates, their challenge sets and invites.

All three are company tables (`kernel.db.org_scoped`): a query needs the company in scope and row-level security hides every other company's rows. A
template's rules are copied onto each invite when it is made (`Invite.rules`), and an attempt copies them from the invite when it starts, so editing a template
never changes the rules of an invite already sent or of an attempt already running (FR-ASM-01). An invite keeps only the hash of its token (FR-ASM-02);
`token_hash` is emptied by the invite purge of story P-24, which is why it may be NULL.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base, org_scoped
from vulnmart.kernel.models import JsonValue

HINTS_MODES = ("off", "on")
INVITE_STATES = ("created", "sent", "opened", "consented", "started", "expired", "cancelled", "declined", "revoked")
LIVE_STATES = ("created", "sent", "opened", "consented")  # an invite that can still be used; the others are closed for good


@org_scoped("org_id")
class AssessmentTemplate(Base):
    __tablename__ = "assessment_templates"
    __table_args__ = (
        CheckConstraint("hints_mode IN ('off', 'on')", name="hints_mode"),
        CheckConstraint("time_limit_min BETWEEN 30 AND 480", name="time_limit_min"),
        CheckConstraint("hint_cost_pct BETWEEN 0 AND 100", name="hint_cost_pct"),
        CheckConstraint("reset_limit BETWEEN 0 AND 10", name="reset_limit"),
        CheckConstraint("invite_expiry_days BETWEEN 1 AND 30", name="invite_expiry_days"),
        CheckConstraint("retention_days BETWEEN 30 AND 365", name="retention_days"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    time_limit_min: Mapped[int] = mapped_column(Integer, nullable=False)
    hints_mode: Mapped[str] = mapped_column(String(3), nullable=False, server_default="off")
    hint_cost_pct: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    reset_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    invite_expiry_days: Mapped[int] = mapped_column(Integer, nullable=False)
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False)
    settings: Mapped[Any] = mapped_column(JsonValue, nullable=False)  # writeup_required, results_visibility, flag_submissions_per_minute
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")  # raised by every edit
    created_by: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


@org_scoped("org_id")
class TemplateChallenge(Base):
    """One challenge of a template's set. Carries `org_id` (the first sketch of the table did not) so that the same central filter applies to it."""

    __tablename__ = "template_challenges"

    template_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_templates.id", ondelete="CASCADE"), primary_key=True)
    challenge_key: Mapped[str] = mapped_column(String(8), primary_key=True)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)


@org_scoped("org_id")
class Invite(Base):
    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint("state IN ('created', 'sent', 'opened', 'consented', 'started', 'expired', 'cancelled', 'declined', 'revoked')", name="state"),
        Index("uq_invites_token_hash", "token_hash", unique=True),
        Index("uq_invites_live_email", "template_id", "email_ci", unique=True,
              postgresql_where=text("state IN ('created', 'sent', 'opened', 'consented')"), sqlite_where=text("state IN ('created', 'sent', 'opened', 'consented')")),
        Index("ix_invites_org_state", "org_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(18), primary_key=True)  # `i-` and 16 Base32 characters
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    template_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_templates.id"), nullable=False, index=True)  # NO ACTION: checked at the end of a statement, so deleting a company can cascade to both
    template_version: Mapped[int] = mapped_column(Integer, nullable=False)
    rules: Mapped[Any] = mapped_column(JsonValue, nullable=False)  # the template's rules as they were when the invite was made
    email_ci: Mapped[str] = mapped_column(String(254), nullable=False)
    token_hash: Mapped[str | None] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(10), nullable=False, server_default="created")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    superseded_by: Mapped[str | None] = mapped_column(String(18))
    outbox_id: Mapped[int | None] = mapped_column(BigInteger)  # the queued mail; `sent` is read from it
    created_by: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # when it became expired, cancelled, declined or revoked
