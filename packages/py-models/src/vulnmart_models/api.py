# GENERATED from contracts/api/bundle/openapi.json (IF-1 and IF-2). Do not edit: run `node scripts/generate-api-code.mjs`.

from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class Timestamp(RootModel[AwareDatetime]):
    root: Annotated[
        AwareDatetime,
        Field(
            description='UTC to the second.',
            pattern='^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$',
        ),
    ]


class InstanceId(RootModel[str]):
    root: Annotated[str, Field(pattern='^i-[A-Z2-7]{16}$')]


class AttemptId(RootModel[str]):
    root: Annotated[str, Field(pattern='^a-[A-Z2-7]{16}$')]


class ChallengeKey(RootModel[str]):
    root: Annotated[str, Field(pattern='^C(0[1-9]|10|11)$')]


class UserId(RootModel[str]):
    root: Annotated[
        str,
        Field(description='u- plus 16 Base32 characters.', pattern='^u-[A-Z2-7]{16}$'),
    ]


class ConsentId(RootModel[str]):
    root: Annotated[
        str,
        Field(description='k- plus 16 Base32 characters.', pattern='^k-[A-Z2-7]{16}$'),
    ]


class Email(RootModel[str]):
    root: Annotated[str, Field(max_length=254, min_length=3)]


class Password(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='At least 12 and at most 128 characters (a proposal, FR-ACC-08 leaves the quality rules to be tuned;\nsee the open points). Never in a log or an answer. A password in a breach list is refused with 422.\n',
            max_length=128,
            min_length=12,
        ),
    ]


class Token(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='A link token, URL-safe, single use, stored only as a hash.',
            pattern='^[A-Za-z0-9_-]{32,128}$',
        ),
    ]


class CsrfToken(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='The signed, session-bound CSRF token.',
            pattern='^[A-Za-z0-9_-]{32,128}$',
        ),
    ]


class MfaCode(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='A six digit authenticator code, or one recovery code (ten Base32 characters).',
            pattern='^([0-9]{6}|[A-Z2-7]{10})$',
        ),
    ]


class Status(Enum):
    ok = 'ok'
    degraded = 'degraded'


class ServiceHealth(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Status


class AcceptedStatus(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Literal['accepted']


class VerifiedStatus(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Literal['verified']


class SignupRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    email: Email
    password: Password
    display_name: Annotated[str, Field(max_length=60, min_length=1)]
    age_declaration: Annotated[
        Literal[True],
        Field(
            description='The person declares to be 18 or over (FR-ACC-01, FR-PRV-13). Only `true` is accepted.'
        ),
    ]
    captcha_token: Annotated[
        str | None,
        Field(
            description='PENDING OI-29 (whether learner signup needs a CAPTCHA). Optional until decided.',
            max_length=2048,
        ),
    ] = None


class EmailRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    email: Email


class TokenRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    token: Token


class LoginRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    email: Email
    password: Annotated[str, Field(max_length=128, min_length=1)]


class MfaLoginRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    mfa_ticket: Token
    code: MfaCode


class MfaCodeRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    code: Annotated[str, Field(pattern='^[0-9]{6}$')]


class PasswordConfirmRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    password: Annotated[str, Field(max_length=128, min_length=1)]


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    current_password: Annotated[str, Field(max_length=128, min_length=1)]
    new_password: Password


class ResetPasswordRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    token: Token
    new_password: Password


class UpdateMeRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    display_name: Annotated[str | None, Field(max_length=60, min_length=1)] = None


class AccountType(Enum):
    participant = 'participant'
    recruiter = 'recruiter'
    admin = 'admin'


class User(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    user_id: UserId
    email: Email
    display_name: Annotated[str, Field(max_length=60, min_length=1)]
    account_type: Annotated[
        AccountType,
        Field(
            description='The account types of the architecture (04 section 2.1). A participant acts as a learner on a practice attempt and as a candidate on an assessment attempt.'
        ),
    ]
    email_verified: bool
    mfa_enabled: bool
    created_at: Timestamp


class Session(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Literal['authenticated']
    user: User
    csrf_token: CsrfToken
    idle_expires_at: Annotated[
        Timestamp,
        Field(
            description='When the session ends if nothing happens (30 minutes, admin 15; FR-ACC-04).'
        ),
    ]
    absolute_expires_at: Annotated[
        Timestamp,
        Field(
            description='When the session ends whatever happens (12 hours; FR-ACC-04).'
        ),
    ]


class MfaRequired(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    status: Literal['mfa_required']
    mfa_ticket: Token
    mfa_ticket_expires_at: Timestamp


class LoginResult(RootModel[Session | MfaRequired]):
    root: Annotated[Session | MfaRequired, Field(discriminator='status')]


class MfaEnrolment(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    otpauth_uri: Annotated[str, Field(max_length=300, pattern='^otpauth://totp/')]


class RecoveryCode(RootModel[str]):
    root: Annotated[str, Field(pattern='^[A-Z2-7]{10}$')]


class MfaRecoveryCodes(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    recovery_codes: Annotated[list[RecoveryCode], Field(max_length=10, min_length=8)]


class ConsentNotice(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    notice_version: Annotated[str, Field(pattern='^\\d{4}-\\d{2}-\\d{2}\\.\\d{1,3}$')]
    notice_text: Annotated[str, Field(max_length=20000)]
    notice_text_sha256: Annotated[str, Field(pattern='^[0-9a-f]{64}$')]
    retention_days_shown: Annotated[int, Field(ge=1)]
    company_name: Annotated[str, Field(max_length=120, min_length=1)]


class Decision(Enum):
    granted = 'granted'
    declined = 'declined'


class ConsentRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    notice_version: Annotated[str, Field(pattern='^\\d{4}-\\d{2}-\\d{2}\\.\\d{1,3}$')]
    notice_text_sha256: Annotated[str, Field(pattern='^[0-9a-f]{64}$')]
    decision: Decision


class Decision1(Enum):
    granted = 'granted'
    declined = 'declined'
    withdrawn = 'withdrawn'


class ConsentRecord(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    consent_id: ConsentId
    attempt_id: AttemptId
    notice_version: Annotated[str, Field(pattern='^\\d{4}-\\d{2}-\\d{2}\\.\\d{1,3}$')]
    decision: Annotated[
        Decision1,
        Field(
            description='A withdrawal adds the value `withdrawn` (no route writes it yet; deletion requests, story P-25, delete the record instead).'
        ),
    ]
    recorded_at: Timestamp


class ConsentRecordList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[ConsentRecord], Field(max_length=100)]
    has_more: bool


class DeletionRequestId(RootModel[str]):
    root: Annotated[
        str,
        Field(description='d- plus 16 Base32 characters.', pattern='^d-[A-Z2-7]{16}$'),
    ]


class Kind(Enum):
    learner = 'learner'
    candidate = 'candidate'


class DeletionRequestCreate(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Kind
    attempt_id: AttemptId | None = None


class Status1(Enum):
    pending = 'pending'
    approved = 'approved'
    declined = 'declined'
    cancelled = 'cancelled'
    done = 'done'


class DeletionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    request_id: DeletionRequestId
    kind: Kind
    status: Annotated[
        Status1,
        Field(
            description='A learner request stays `pending` until it runs; a candidate request is `pending` until the company decides, then `approved` (waiting) or `declined`.'
        ),
    ]
    requested_at: Timestamp
    attempt_id: Annotated[str | None, Field(pattern='^a-[A-Z2-7]{16}$')]
    company_name: Annotated[str | None, Field(max_length=120)]
    decide_by: Timestamp | None
    decided_at: Timestamp | None
    execute_after: Timestamp | None
    finished_at: Timestamp | None
    can_undo: bool


class DeletionRequestList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[DeletionRequest], Field(max_length=100)]


class SessionRef(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description="A handle for one of the caller's sessions: the first 16 hex characters of the stored hash of the session value.",
            pattern='^[0-9a-f]{16}$',
        ),
    ]


class UaClass(Enum):
    browser = 'browser'
    mobile = 'mobile'
    tool = 'tool'
    NoneType_None = None


class MySession(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    ref: SessionRef
    created_at: Timestamp
    last_seen_at: Timestamp
    ip_trunc: Annotated[
        str | None,
        Field(
            description='A network prefix (IPv4 /24, IPv6 /48), never the address.',
            max_length=64,
        ),
    ]
    ua_class: UaClass | None
    current: Annotated[bool, Field(description='This is the session making the call.')]


class MySessionList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[MySession], Field(max_length=100)]


class Action(Enum):
    viewed = 'viewed'
    exported = 'exported'


class DataView(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    company_name: Annotated[str, Field(max_length=120)]
    action: Action
    at: Timestamp


class DataViewList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[DataView], Field(max_length=100)]
    has_more: bool


class InviteTokenRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    token: Annotated[
        str,
        Field(
            description='The token of the invite link (the company prefix and the secret); never logged.',
            max_length=200,
            min_length=1,
        ),
    ]


class State(Enum):
    created = 'created'
    sent = 'sent'
    opened = 'opened'
    consented = 'consented'
    started = 'started'
    declined = 'declined'
    expired = 'expired'
    cancelled = 'cancelled'
    revoked = 'revoked'


class HintsMode(Enum):
    off = 'off'
    on = 'on'


class ResultsVisibility(Enum):
    after_submit = 'after_submit'
    after_release = 'after_release'


class InviteSummary(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state: State
    company_name: Annotated[str, Field(max_length=200)]
    title: Annotated[str, Field(max_length=200)]
    expires_at: Timestamp
    time_limit_min: Annotated[int | None, Field(ge=1)]
    challenge_count: Annotated[int, Field(ge=0, le=11)]
    hints_mode: HintsMode
    hint_cost_pct: Annotated[int, Field(ge=0, le=100)]
    writeup_required: bool
    results_visibility: ResultsVisibility


class MyInvite(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    invite_id: Annotated[str, Field(max_length=64)]
    attempt_id: AttemptId | None
    state: State
    company_name: Annotated[str, Field(max_length=200)]
    title: Annotated[str, Field(max_length=200)]
    expires_at: Timestamp
    time_limit_min: Annotated[int | None, Field(ge=1)]
    challenge_count: Annotated[int, Field(ge=0, le=11)]
    hints_mode: HintsMode
    hint_cost_pct: Annotated[int, Field(ge=0, le=100)]
    writeup_required: bool
    results_visibility: ResultsVisibility


class MyInviteList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[MyInvite], Field(max_length=100)]


class RecruiterSignupRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    email: Email
    password: Password
    display_name: Annotated[str, Field(max_length=60, min_length=1)]
    company_name: Annotated[str, Field(max_length=120, min_length=1)]
    captcha_token: Annotated[str | None, Field(max_length=2048)] = None


class State2(Enum):
    none = 'none'
    unverified_email = 'unverified_email'
    pending_approval = 'pending_approval'
    active = 'active'
    rejected = 'rejected'
    suspended = 'suspended'
    deleted = 'deleted'


class Role(Enum):
    owner = 'owner'
    member = 'member'
    NoneType_None = None


class CompanyStanding(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state: State2
    company_name: Annotated[str | None, Field(max_length=120)]
    reason: Annotated[str | None, Field(max_length=500)]
    terms_accepted: bool
    role: Role


class CompanyTerms(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    version: Annotated[str, Field(max_length=40)]
    text: Annotated[str, Field(max_length=20000)]
    sha256: Annotated[str, Field(pattern='^[0-9a-f]{64}$')]


class TermsAcceptRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    version: Annotated[str, Field(max_length=40, min_length=1)]
    sha256: Annotated[str, Field(pattern='^[0-9a-f]{64}$')]


class TemplateRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    title: Annotated[str, Field(max_length=200, min_length=1)]
    challenge_keys: Annotated[list[ChallengeKey], Field(max_length=11, min_length=1)]
    time_limit_min: Annotated[int | None, Field(ge=30, le=480)] = None
    hints_mode: HintsMode | None = None
    hint_cost_pct: Annotated[int | None, Field(ge=0, le=100)] = None
    reset_limit: Annotated[int | None, Field(ge=0, le=10)] = None
    invite_expiry_days: Annotated[int | None, Field(ge=1, le=30)] = None
    retention_days: Annotated[int | None, Field(ge=30, le=365)] = None
    writeup_required: bool | None = None
    results_visibility: ResultsVisibility | None = None
    flag_submissions_per_minute: Annotated[int | None, Field(ge=1, le=60)] = None


class Template(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    template_id: UUID
    title: Annotated[str, Field(max_length=200, min_length=1)]
    challenge_keys: Annotated[list[ChallengeKey], Field(max_length=11, min_length=1)]
    time_limit_min: Annotated[int, Field(ge=30, le=480)]
    hints_mode: HintsMode
    hint_cost_pct: Annotated[int, Field(ge=0, le=100)]
    reset_limit: Annotated[int, Field(ge=0, le=10)]
    invite_expiry_days: Annotated[int, Field(ge=1, le=30)]
    retention_days: Annotated[int, Field(ge=30, le=365)]
    writeup_required: bool
    results_visibility: ResultsVisibility
    flag_submissions_per_minute: Annotated[int, Field(ge=1, le=60)]
    version: Annotated[int, Field(ge=1)]
    updated_at: Timestamp


class TemplateList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[Template], Field(max_length=100)]


class Email1(RootModel[str]):
    root: Annotated[str, Field(max_length=254)]


class InvitesRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    template_id: UUID
    emails: Annotated[list[Email1], Field(max_length=500, min_length=1)]


class Action1(Enum):
    resend = 'resend'
    cancel = 'cancel'
    revoke = 'revoke'
    reinvite = 'reinvite'


class InviteActionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Action1


class State3(Enum):
    created = 'created'
    sent = 'sent'
    opened = 'opened'
    consented = 'consented'
    started = 'started'
    declined = 'declined'
    expired = 'expired'
    cancelled = 'cancelled'
    revoked = 'revoked'


class CompanyInvite(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    invite_id: Annotated[str, Field(pattern='^i-[A-Z2-7]{16}$')]
    template_id: UUID
    email: Annotated[str, Field(max_length=254)]
    state: State3
    attempt_id: AttemptId | None
    generation: Annotated[int, Field(ge=1)]
    superseded_by: Annotated[str | None, Field(max_length=64)]
    expires_at: Timestamp
    created_at: Timestamp
    sent_at: Timestamp | None
    opened_at: Timestamp | None
    consented_at: Timestamp | None
    started_at: Timestamp | None
    closed_at: Timestamp | None
    time_limit_min: Annotated[int | None, Field(ge=1)]
    hints_mode: HintsMode
    hint_cost_pct: Annotated[int, Field(ge=0, le=100)]
    results_visibility: ResultsVisibility


class CompanyInviteList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[CompanyInvite], Field(max_length=100)]


class Reason(Enum):
    invalid = 'invalid'
    duplicate = 'duplicate'
    exists = 'exists'
    started = 'started'


class SkippedItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    email: Annotated[str, Field(max_length=254)]
    reason: Reason


class RemainingItem(RootModel[str]):
    root: Annotated[str, Field(max_length=254)]


class InvitesResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    created: Annotated[list[CompanyInvite], Field(max_length=500)]
    skipped: Annotated[list[SkippedItem], Field(max_length=500)]
    remaining: Annotated[list[RemainingItem], Field(max_length=500)]
    cap: Annotated[int | None, Field(ge=0)]


class CompanyExportRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    template_id: UUID


class AuditEntry(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    seq: Annotated[int, Field(ge=1)]
    at: Annotated[str, Field(max_length=40)]
    actor: Annotated[str, Field(max_length=80)]
    action: Annotated[str, Field(max_length=64)]
    subject: Annotated[str | None, Field(max_length=80)]
    details: dict[str, Any]


class AuditEntryList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[AuditEntry], Field(max_length=200)]
    next_after_seq: int | None


class BreakGlassRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    reason: Annotated[str, Field(max_length=500, min_length=20)]


class BreakGlassReviewRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    note: Annotated[str, Field(max_length=500, min_length=1)]


class State4(Enum):
    open = 'open'
    over = 'over'
    reviewed = 'reviewed'


class BreakGlassSession(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    session_id: Annotated[str, Field(pattern='^g-[A-Z2-7]{16}$')]
    admin_id: Annotated[str, Field(max_length=32)]
    admin_name: Annotated[str, Field(max_length=80)]
    attempt_id: AttemptId
    org_id: Annotated[str, Field(max_length=40)]
    reason: Annotated[str, Field(max_length=500)]
    started_at: Timestamp
    expires_at: Timestamp
    closed_at: Timestamp | None
    reads: Annotated[list[dict[str, Any]], Field(max_length=500)]
    reviewed_by: Annotated[str | None, Field(max_length=32)]
    reviewed_at: Timestamp | None
    review_note: Annotated[str | None, Field(max_length=500)]
    state: State4


class BreakGlassSessionList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[BreakGlassSession], Field(max_length=100)]


class BreakGlassRead(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    session_id: Annotated[str, Field(pattern='^g-[A-Z2-7]{16}$')]
    attempt_id: AttemptId
    expires_at: Annotated[str, Field(max_length=40)]
    results: dict[str, Any]
    timeline: Annotated[list[dict[str, Any]], Field(max_length=1000)]


class PendingCompany(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    org_id: Annotated[
        str,
        Field(
            pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        ),
    ]
    name: Annotated[str, Field(max_length=120)]
    owner_name: Annotated[str, Field(max_length=60)]
    owner_email_domain: Annotated[str, Field(max_length=253)]
    applied_at: Timestamp


class PendingCompanyList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[PendingCompany], Field(max_length=100)]


class Decision2(Enum):
    approve = 'approve'
    reject = 'reject'
    suspend = 'suspend'
    reinstate = 'reinstate'


class CompanyDecisionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    decision: Decision2
    reason: Annotated[str | None, Field(max_length=500, min_length=1)] = None


class Status2(Enum):
    active = 'active'
    disabled = 'disabled'


class Role1(Enum):
    learner = 'learner'
    candidate = 'candidate'


class AdminUser(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    user_id: UserId
    display_name: Annotated[str, Field(max_length=60)]
    email: Annotated[str, Field(max_length=254)]
    account_type: AccountType
    status: Status2
    roles: list[Role1]
    email_verified: bool
    created_at: Timestamp
    last_login_at: Timestamp | None


class AdminUserList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[AdminUser], Field(max_length=100)]


class Action2(Enum):
    lock = 'lock'
    unlock = 'unlock'
    reset_password = 'reset_password'
    delete = 'delete'


class UserActionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    action: Action2
    reason: Annotated[str | None, Field(max_length=500, min_length=1)] = None


class Outcome(Enum):
    locked = 'locked'
    unlocked = 'unlocked'
    reset_sent = 'reset_sent'
    deleted = 'deleted'
    locked_instead = 'locked_instead'


class UserActionResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    outcome: Outcome


class ForceStopResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    instance_stopped: bool


class AdminSetting(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    name: str
    value: int | bool | str
    default: int | bool | str
    overridden: bool
    minimum: int | None
    maximum: int | None


class AdminSettingList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: list[AdminSetting]


class Value(RootModel[str]):
    root: Annotated[str, Field(max_length=200, min_length=1)]


class SettingUpdateRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    value: int | bool | Value


class Scope(Enum):
    user = 'user'
    org = 'org'
    global_ = 'global'


class Quota(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    scope: Scope
    scope_id: Annotated[str | None, Field(max_length=64)]
    max_instances: Annotated[int, Field(ge=0, le=10000)]


class QuotaList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: list[Quota]


class QuotaRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    scope: Scope
    scope_id: Annotated[str | None, Field(max_length=64)] = None
    max_instances: Annotated[int, Field(ge=0, le=10000)]


class Instances(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    running: Annotated[int, Field(ge=0)]
    reported: Annotated[int, Field(ge=0)]
    failed: Annotated[int, Field(ge=0)]


class Memory(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    capacity_mb: Annotated[int, Field(ge=0)]
    used_mb: Annotated[int, Field(ge=0)]
    health: str


class Queue(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    emails_waiting: Annotated[int, Field(ge=0)]
    events_unpublished: Annotated[int, Field(ge=0)]


class Failures(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    emails_failed: Annotated[int, Field(ge=0)]
    jobs_failed: Annotated[int, Field(ge=0)]
    instances_failed: Annotated[int, Field(ge=0)]


class Capacity(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    instances: Instances
    memory: Annotated[
        Memory | None, Field(description='Null when this process has no lab to ask.')
    ]
    queue: Queue
    failures: Failures


class LastStatus(Enum):
    running = 'running'
    succeeded = 'succeeded'
    failed = 'failed'
    NoneType_None = None


class JobStatus(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    name: str
    interval_seconds: Annotated[int, Field(ge=1)]
    last_started_at: Timestamp | None
    last_finished_at: Timestamp | None
    last_status: LastStatus
    last_detail: str | None
    last_success_at: Timestamp | None
    next_due_at: Timestamp


class JobStatusList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: list[JobStatus]


class Owasp(RootModel[str]):
    root: Annotated[str, Field(pattern='^A(0[1-9]|10)$')]


class Tier(Enum):
    Easy = 'Easy'
    Medium = 'Medium'
    Hard = 'Hard'


class CatalogueSummary(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    title: Annotated[str, Field(max_length=120, min_length=1)]
    owasp_2021: Annotated[
        Owasp | None,
        Field(
            description='The OWASP Top 10 2021 category, or null when the challenge has none (IF-7).'
        ),
    ]
    owasp_2025: Owasp
    difficulty: Annotated[int, Field(ge=1, le=5)]
    tier: Tier


class AttackItem(RootModel[str]):
    root: Annotated[str, Field(pattern='^T[0-9]{4}(\\.[0-9]{3})?$')]


class CatalogueChallenge(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    title: Annotated[str, Field(max_length=120, min_length=1)]
    owasp_2021: Owasp | None
    owasp_2025: Owasp
    difficulty: Annotated[int, Field(ge=1, le=5)]
    tier: Tier
    cwe_primary: Annotated[str, Field(pattern='^CWE-[0-9]+$')]
    attack: Annotated[list[AttackItem], Field(max_length=20)]


class CatalogueList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[CatalogueSummary], Field(max_length=11)]
    has_more: bool


class Mode(Enum):
    learner = 'learner'
    candidate = 'candidate'


class State5(Enum):
    invited = 'invited'
    consent = 'consent'
    ready = 'ready'
    running = 'running'
    submitted = 'submitted'
    reported = 'reported'
    withdrawn = 'withdrawn'
    expired = 'expired'
    cancelled = 'cancelled'
    deleted = 'deleted'


class AttemptSummary(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    mode: Mode
    state: Annotated[
        State5,
        Field(
            description='The ten attempt states of the architecture (04 section 10.1); the same as IF-2 and IF-3.'
        ),
    ]
    instance_id: InstanceId | None
    created_at: Timestamp
    deadline_at: Timestamp | None


class AttemptSummaryList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[AttemptSummary], Field(max_length=100)]
    has_more: bool


class State6(Enum):
    requested = 'requested'
    provisioning = 'provisioning'
    starting = 'starting'
    ready = 'ready'
    active = 'active'
    idle = 'idle'
    resetting = 'resetting'
    stopping = 'stopping'
    destroyed = 'destroyed'
    failed = 'failed'


class Access(Enum):
    open = 'open'
    frozen = 'frozen'
    closed = 'closed'


class Health(Enum):
    unknown = 'unknown'
    healthy = 'healthy'
    unhealthy = 'unhealthy'


class ErrorCode(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='An INST-* code while the state is failed, otherwise null.',
            max_length=60,
            pattern='^INST(-[A-Z]+)+$',
        ),
    ]


class InstanceSummary(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    instance_id: InstanceId
    attempt_id: AttemptId
    state: Annotated[
        State6,
        Field(
            description='The ten instance states of IF-5 (identical in IF-2 and IF-3).'
        ),
    ]
    access: Access
    health: Health
    epoch: Annotated[int, Field(ge=1)]
    error_code: Annotated[
        ErrorCode | None,
        Field(description='An INST-* code while the state is failed, otherwise null.'),
    ]


class LiveSnapshot(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    server_time: Timestamp
    attempts: Annotated[list[AttemptSummary], Field(max_length=100)]
    instances: Annotated[list[InstanceSummary], Field(max_length=100)]


class LiveTicket(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    ticket: Token
    expires_at: Timestamp


class Error(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    pointer: Annotated[str, Field(max_length=200, pattern='^(/([^/~]|~[01])*)*$')]
    detail: Annotated[str, Field(max_length=200, min_length=1)]


class Problem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Annotated[
        str,
        Field(
            description='urn:vulnmart:error: plus the code.',
            max_length=100,
            pattern='^urn:vulnmart:error:[A-Z]{2,6}(-[A-Z]+)+$',
        ),
    ]
    title: Annotated[
        str,
        Field(
            description="The registry's fixed generic text for the code.",
            max_length=200,
            min_length=1,
        ),
    ]
    status: Annotated[int, Field(ge=400, le=599)]
    code: Annotated[str, Field(max_length=60, pattern='^[A-Z]{2,6}(-[A-Z]+)+$')]
    request_id: Annotated[str, Field(pattern='^[A-Za-z0-9-]{8,64}$')]
    field: Annotated[
        str | None,
        Field(
            description='One JSON Pointer to the offending field (empty string for the whole body).',
            max_length=200,
            pattern='^(/([^/~]|~[01])*)*$',
        ),
    ] = None
    errors: Annotated[
        list[Error] | None,
        Field(
            description='For 422 with several problems: one entry per offending field. The detail is a fixed generic text and never repeats the submitted value.',
            max_length=50,
            min_length=1,
        ),
    ] = None


class IntegrityFlagId(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Proposal: g- plus 16 Base32 characters.',
            pattern='^g-[A-Z2-7]{16}$',
        ),
    ]


class EvidenceId(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Proposal: e- plus 16 Base32 characters.',
            pattern='^e-[A-Z2-7]{16}$',
        ),
    ]


class Cursor(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Opaque. base64url (no padding) of a text that holds the direction (f, forward) and the key (epoch, seq) of the last\nentry already read. Clients must not build or change one. A cursor that is not one of ours is 422 with field /query/cursor.\n',
            pattern='^[A-Za-z0-9_-]{1,128}$',
        ),
    ]


class AttemptState(Enum):
    invited = 'invited'
    consent = 'consent'
    ready = 'ready'
    running = 'running'
    submitted = 'submitted'
    reported = 'reported'
    withdrawn = 'withdrawn'
    expired = 'expired'
    cancelled = 'cancelled'
    deleted = 'deleted'


class AttemptMode(Enum):
    learner = 'learner'
    candidate = 'candidate'


class Milestone(Enum):
    none = 'none'
    M1 = 'M1'
    M2 = 'M2'
    M3 = 'M3'


class FlagResult(Enum):
    correct = 'correct'
    incorrect = 'incorrect'


class ErrorCode1(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Code of a failed instance, `INST-` plus upper-case words (for example INST-HEALTH-TIMEOUT), the same\nform as IF-5 and the registry. This is not the code of a problem answer; see Problem.\n',
            pattern='^(AUTH|ATT|INST|REQ)-[A-Z0-9]+(-[A-Z0-9]+)*$',
        ),
    ]


class Kind2(Enum):
    learner = 'learner'


class RequestInstanceRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Kind2


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    confirm: Literal[True]


class Instance(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    instance_id: InstanceId
    attempt_id: AttemptId
    state: State6
    access: Access
    health: Health
    epoch: Annotated[int, Field(ge=1)]
    error_code: Annotated[
        ErrorCode1 | None,
        Field(description='Set while the state is failed, otherwise null.'),
    ]
    requested_at: Timestamp
    ready_at: Timestamp | None
    expires_at: Timestamp | None
    updated_at: Timestamp


class OpenTicket(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    url: Annotated[
        str,
        Field(
            description='One-time URL on the instance host (architecture 03 section 3). Single use. The ticket is payload.signature (two base64url parts joined by a dot, contracts/edge/gate-ticket.md section 2).',
            max_length=1024,
            pattern='^https://[a-z0-9.-]+/_vm/enter\\?t=[A-Za-z0-9_-]{16,512}\\.[A-Za-z0-9_-]{16,512}$',
        ),
    ]
    expires_at: Timestamp


class Attempt(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    mode: AttemptMode
    state: AttemptState
    hints_enabled: bool
    instance_id: InstanceId | None
    started_at: Timestamp | None
    deadline_at: Timestamp | None
    submitted_at: Timestamp | None
    frozen_until: Timestamp | None
    delete_after: Annotated[
        Timestamp | None,
        Field(
            description='Optional. Present only while the attempt is `withdrawn` (the end of the undo window when the deletion is scheduled, null once the withdrawal was undone). Absent in every other state.'
        ),
    ] = None
    server_time: Annotated[
        Timestamp,
        Field(
            description='The server clock; the browser timer is cosmetic (FR-SES-02).'
        ),
    ]


class FlagSubmissionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    flag: Annotated[
        str,
        Field(
            description='The pasted text. Never echoed, never stored.',
            max_length=200,
            min_length=1,
        ),
    ]


class Credit(Enum):
    credited = 'credited'
    held = 'held'
    none = 'none'


class FlagSubmissionResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    result: FlagResult
    credit: Annotated[
        Credit,
        Field(
            description='credited for a correct value that passed the activity check, held when it did not (FR-ACH-02), none otherwise.'
        ),
    ]


class ChallengeScore(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    best_milestone: Milestone
    held: Annotated[
        bool,
        Field(description='A capture waits for a human decision and is not counted.'),
    ]
    hints_used: Annotated[int, Field(ge=0, le=3)]
    points: Annotated[
        int, Field(description='Net points after hint cost (FR-SCR-01).', ge=0)
    ]


class Score(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    score: Annotated[int, Field(ge=0, le=1000)]
    computed_at: Timestamp
    per_challenge: Annotated[list[ChallengeScore], Field(max_length=11)]


class WriteUp(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    vulnerable: Annotated[str, Field(max_length=800)]
    fix: Annotated[str, Field(max_length=1200)]


class State8(Enum):
    ready = 'ready'
    active = 'active'
    solved = 'solved'
    expired = 'expired'


class SecondsLeft(RootModel[int]):
    root: Annotated[
        int,
        Field(
            description='Optional (sequenced run). Seconds left when the answer was made; null unless the challenge is `active`. The browser counts down from it.',
            ge=0,
            le=86400,
        ),
    ]


class ChallengeProgress(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    best_milestone: Milestone
    solved: bool
    held: bool
    hints_used: Annotated[int, Field(ge=0, le=3)]
    hints_available: Annotated[
        bool, Field(description='False when the attempt has hints off.')
    ]
    brief: Annotated[
        str | None,
        Field(
            description='Optional. What the challenge is about, in a few plain words (the catalogue text; never a flag).',
            max_length=600,
        ),
    ] = None
    start: Annotated[
        str | None,
        Field(
            description='Optional. How to begin, for example the demo account to sign in with and where to look. The accounts are documented demo accounts of the lab shop, not real credentials.',
            max_length=600,
        ),
    ] = None
    write_up: Annotated[
        WriteUp | None,
        Field(
            description='Optional. Present only for the owner of a practice attempt once the challenge is captured (M3) or timed out; never in an assessment. The weakness and the fix.'
        ),
    ] = None
    state: Annotated[
        State8 | None,
        Field(
            description='Optional (a sequenced practice run only, v1.3.0). `ready`: the current challenge, not begun. `active`: begun, the countdown runs.\n`solved`: captured (or held for review). `expired`: the time ran out; nothing counts for it any more.\n'
        ),
    ] = None
    title: Annotated[
        str | None,
        Field(
            description='Optional (sequenced run). The catalogue title of the challenge.',
            max_length=120,
        ),
    ] = None
    tier: Annotated[
        Tier | None,
        Field(
            description='Optional (sequenced run). The tier of the catalogue; it sets the time (Easy 20, Medium 40, Hard 60 minutes).'
        ),
    ] = None
    time_limit_seconds: Annotated[
        int | None,
        Field(
            description='Optional (sequenced run). The time the challenge has once begun.',
            ge=1,
            le=86400,
        ),
    ] = None
    opened_at: Annotated[
        Timestamp | None,
        Field(
            description='Optional (sequenced run). When the challenge was begun; null before.'
        ),
    ] = None
    expires_at: Annotated[
        Timestamp | None,
        Field(
            description='Optional (sequenced run). When the countdown ends; null before the challenge is begun.'
        ),
    ] = None
    seconds_left: Annotated[
        SecondsLeft | None,
        Field(
            description='Optional (sequenced run). Seconds left when the answer was made; null unless the challenge is `active`. The browser counts down from it.'
        ),
    ] = None


class ChallengeProgressList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[ChallengeProgress], Field(max_length=11)]
    has_more: Annotated[
        Literal[False],
        Field(
            description='Always false here; the list is complete and has a fixed size (not truncated).'
        ),
    ]
    total: Annotated[
        int | None,
        Field(
            description='Optional (sequenced run). How many challenges the run has in all, so the browser can show "3 of 11" without listing the ones ahead.',
            ge=1,
            le=11,
        ),
    ] = None
    current_key: Annotated[
        ChallengeKey | None,
        Field(
            description='Optional (sequenced run). The challenge to work on now; null when every challenge is solved or timed out.'
        ),
    ] = None
    server_time: Annotated[
        Timestamp | None,
        Field(
            description='Optional (sequenced run). The server clock when the answer was made.'
        ),
    ] = None


class AccountChallengePoints(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    best_points: Annotated[
        int,
        Field(
            description='The best net points of this challenge over all runs (the points of one challenge',
            ge=0,
        ),
    ]


class AccountProgress(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    total_points: Annotated[
        int,
        Field(
            description='The best points of every challenge added up and shown out of 1000',
            ge=0,
            le=1000,
        ),
    ]
    runs: Annotated[
        int, Field(description='How many practice runs the learner has started.', ge=0)
    ]
    per_challenge: Annotated[list[AccountChallengePoints], Field(max_length=11)]


class Kind3(Enum):
    nudge = 'nudge'
    direction = 'direction'
    near_solution = 'near_solution'


class Text(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Null until unlocked. A hint never reveals a flag (FR-HNT-01).',
            max_length=2000,
        ),
    ]


class Hint(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    level: Annotated[int, Field(ge=1, le=3)]
    kind: Kind3
    unlocked: bool
    cost_pct: Annotated[
        int,
        Field(
            description='Cost as a percentage of the challenge points; 0 for a learner (placeholder 10, 20, 30 for a candidate).',
            ge=0,
            le=100,
        ),
    ]
    text: Annotated[
        Text | None,
        Field(
            description='Null until unlocked. A hint never reveals a flag (FR-HNT-01).'
        ),
    ]


class HintList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    items: Annotated[list[Hint], Field(max_length=3)]
    has_more: Annotated[
        Literal[False],
        Field(
            description='Always false here; the list is complete and has a fixed size (not truncated).'
        ),
    ]


class Method(Enum):
    GET = 'GET'
    POST = 'POST'
    PUT = 'PUT'
    PATCH = 'PATCH'
    DELETE = 'DELETE'


class Body(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='Redacted request body, at most 8 KiB (FR-DET-03); null when there was none.',
            max_length=8192,
        ),
    ]


class Evidence(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    evidence_id: EvidenceId
    challenge_key: ChallengeKey
    captured_at: Timestamp
    method: Method
    path: Annotated[str, Field(max_length=2048, min_length=1)]
    body: Annotated[
        Body | None,
        Field(
            description='Redacted request body, at most 8 KiB (FR-DET-03); null when there was none.'
        ),
    ]
    body_truncated: bool


class EvidenceList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[Evidence], Field(max_length=100)]
    has_more: Annotated[
        bool,
        Field(
            description='True when more entries exist than limit allowed in this answer (the answer is truncated). The entries are the oldest first.'
        ),
    ]


class Type(Enum):
    decoy = 'decoy'
    sharing = 'sharing'
    timing = 'timing'
    activity = 'activity'
    similarity = 'similarity'


class Status3(Enum):
    open = 'open'
    accepted = 'accepted'
    rejected = 'rejected'


class DecisionNote(RootModel[str]):
    root: Annotated[str, Field(max_length=1000)]


class IntegrityFlag(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    integrity_flag_id: IntegrityFlagId
    type: Type
    challenge_key: ChallengeKey | None
    explanation: Annotated[str, Field(max_length=500, min_length=1)]
    status: Status3
    held: Annotated[
        bool,
        Field(
            description='A held capture is linked to this flag and stays out of the score until decided.'
        ),
    ]
    created_at: Timestamp
    decided_at: Timestamp | None
    decision_note: DecisionNote | None


class IntegrityFlagList(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[IntegrityFlag], Field(max_length=100)]
    has_more: Annotated[
        bool,
        Field(
            description='True when more entries exist than limit allowed in this answer (the answer is truncated). The entries are the oldest first.'
        ),
    ]


class Decision3(Enum):
    accept = 'accept'
    reject = 'reject'


class IntegrityDecisionRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    decision: Decision3
    note: Annotated[str, Field(max_length=1000, min_length=1)]


class TimeToCaptureSeconds(RootModel[int]):
    root: Annotated[int, Field(ge=0)]


class TechniqueLabel(RootModel[str]):
    root: Annotated[
        str,
        Field(
            description='An estimate (FR-DET-07), never changes points; null when unknown.',
            max_length=100,
        ),
    ]


class ReportChallenge(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    challenge_key: ChallengeKey
    best_milestone: Milestone
    points: Annotated[int, Field(ge=0)]
    held: bool
    hints_used: Annotated[int, Field(ge=0, le=3)]
    time_to_capture_seconds: TimeToCaptureSeconds | None
    technique_label: Annotated[
        TechniqueLabel | None,
        Field(
            description='An estimate (FR-DET-07), never changes points; null when unknown.'
        ),
    ]


class ElapsedSeconds(RootModel[int]):
    root: Annotated[int, Field(ge=0)]


class ActiveSeconds(RootModel[int]):
    root: Annotated[
        int, Field(description='Estimate (FR-TIM-02); null when not computed.', ge=0)
    ]


class Report(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attempt_id: AttemptId
    mode: AttemptMode
    state: AttemptState
    generated_at: Timestamp
    score: Annotated[int, Field(ge=0, le=1000)]
    elapsed_seconds: ElapsedSeconds | None
    active_seconds: Annotated[
        ActiveSeconds | None,
        Field(description='Estimate (FR-TIM-02); null when not computed.'),
    ]
    hints_used_total: Annotated[int, Field(ge=0, le=33)]
    integrity_open: Annotated[int, Field(ge=0)]
    per_challenge: Annotated[list[ReportChallenge], Field(max_length=11)]


class Type1(Enum):
    attempt_started = 'attempt.started'
    milestone_reached = 'milestone.reached'
    flag_submitted = 'flag.submitted'
    hint_unlocked = 'hint.unlocked'
    instance_reset = 'instance.reset'
    attempt_submitted = 'attempt.submitted'
    attempt_expired = 'attempt.expired'
    attempt_time_warning = 'attempt.time_warning'


class Milestone1(Enum):
    M1 = 'M1'
    M2 = 'M2'
    M3 = 'M3'


class TimelineEntry(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    at: Timestamp
    type: Type1
    challenge_key: ChallengeKey | None
    milestone: Milestone1 | None
    result: FlagResult | None
    minutes_left: Annotated[
        int | None,
        Field(
            description='Optional (v2.0.0). Only on `attempt.time_warning`, how many minutes the attempt had left when the warning went out (the default rules warn at 15 and at 5).',
            ge=1,
            le=1440,
        ),
    ] = None


class Timeline(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    items: Annotated[list[TimelineEntry], Field(max_length=200)]
    has_more: Annotated[
        bool,
        Field(
            description='True when entries with a larger key exist after this page. Exactly when next_cursor is not null.'
        ),
    ]
    next_cursor: Annotated[
        Cursor | None,
        Field(
            description='Null on the last page. Otherwise pass it as `cursor` to get the entries after the last one of this page.\nIt never goes back: an event that arrives late with a smaller key than the cursor is not in the following\npages; read again from the start (cursor left out) to see it.\n'
        ),
    ]
