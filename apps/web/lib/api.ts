// The dashboards' only way to the API (story P-26, ADR 0058): same-origin calls to /api/v1/..., which proxy.ts forwards with the origin secret.
// The session cookie travels by itself; a state-changing call sends the CSRF token the session answer gave. Errors come back as IF-8 problem bodies.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(status: number, code: string, detail?: string, retryAfter?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

let csrfToken: string | null = null;

/** The CSRF token of the current session (from createSession, completeMfaLogin or getSession). */
export function setCsrf(token: string | null): void {
  csrfToken = token;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const problem = (data ?? {}) as { code?: string; errors?: { detail?: string }[] };
    const retry = Number(res.headers.get('retry-after'));
    throw new ApiError(res.status, problem.code ?? `HTTP-${res.status}`, problem.errors?.[0]?.detail, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return data as T;
}

/** POST a request whose answer is a file (the exports, story P-29) and hand it to the browser as a download. Errors are the same ApiError as `api`. */
export async function download(path: string, body: unknown, filename: string): Promise<void> {
  const headers: Record<string, string> = { accept: 'application/zip, application/problem+json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (!res.ok) {
    const problem = ((await res.json().catch(() => null)) ?? {}) as { code?: string };
    throw new ApiError(res.status, problem.code ?? `HTTP-${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// What a person reads for each registry code. Unknown codes get a general sentence that still names the code for support.
const MESSAGES: Record<string, string> = {
  NETWORK: 'The site cannot be reached. Check your connection and try again.',
  'AUTH-INVALID-CREDENTIALS': 'That email and password do not match.',
  'AUTH-EMAIL-NOT-VERIFIED': 'Confirm your email first, with the link we sent you.',
  'AUTH-SESSION-REQUIRED': 'Please sign in.',
  'AUTH-CSRF-FAILED': 'Your session changed. Reload the page and try again.',
  'AUTH-ORIGIN-FORBIDDEN': 'This request came from another site and was refused.',
  'AUTH-TOKEN-INVALID': 'This link is not valid any more. It may have been used already or have expired.',
  'AUTH-MFA-INVALID': 'That code is not right. Try the current code from your authenticator app.',
  'AUTH-MFA-STATE': 'The second factor is not in a state that allows this.',
  'REQ-RATE-LIMITED': 'Too many tries. Wait a little and try again.',
  'REQ-VALIDATION': 'Something in the form is not valid.',
  'REQ-INTERNAL': 'Something went wrong on our side. Try again in a moment.',
  'INST-QUOTA-REACHED': 'You already have a running instance. Stop it before starting another.',
  'INST-NOT-READY': 'The instance is not ready yet.',
  'INST-INVALID-STATE': 'That cannot be done in the instance’s state now.',
  'INST-START-FAILED': 'The lab could not start an instance. Try again in a moment.',
  'ATT-INVALID-STATE': 'That cannot be done in the attempt’s state now.',
  'ATT-NOT-FOUND': 'That was not found.',
  'ATT-GONE': 'That attempt is closed.',
  'ATT-HINTS-DISABLED': 'Hints are off for this assessment.',
  'ATT-FLAG-RATE-LIMITED': 'Too many wrong flags for this challenge. Wait a few minutes.',
  'ATT-CHALLENGE-NOT-FOUND': 'That challenge was not found.',
  'ATT-CONSENT-STALE': 'The notice changed. Read it again and decide.',
};

export function say(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'REQ-VALIDATION' && error.detail) return error.detail; // the password rules answer a fixed sentence (H-134)
    return MESSAGES[error.code] ?? `Something went wrong (${error.code}).`;
  }
  return 'Something went wrong.';
}

// ---- the shapes this app reads (IF-1, IF-2; only the fields used) ----

export type User = {
  user_id: string;
  email: string;
  display_name: string;
  account_type: 'participant' | 'recruiter' | 'admin';
  email_verified: boolean;
  mfa_enabled: boolean;
};
export type Session = { status: 'authenticated'; user: User; csrf_token: string };
export type MfaRequired = { status: 'mfa_required'; mfa_ticket: string };
export type CatalogueItem = { challenge_key: string; title: string; owasp_2021: string | null; owasp_2025: string; difficulty: number; tier: string };
export type AttemptSummary = { attempt_id: string; mode: 'learner' | 'candidate'; state: string; instance_id: string | null; created_at: string; deadline_at: string | null };
export type Attempt = AttemptSummary & { hints_enabled: boolean; started_at: string | null; submitted_at: string | null; delete_after?: string | null };
export type Instance = { instance_id: string; state: string; access: string; epoch: number };
export type Progress = {
  challenge_key: string;
  best_milestone: string;
  solved: boolean;
  held: boolean;
  hints_used: number;
  hints_available: boolean;
  brief?: string; // IF-2 1.2.0 (stream L): what the challenge is about
  start?: string; // how to begin (the lab shop's documented demo accounts)
  write_up?: { vulnerable: string; fix: string }; // only for the owner of a practice attempt after the capture, never in an assessment
};
export type Hint = { level: number; kind: string; unlocked: boolean; cost_pct: number; text: string | null };
export type Score = { score: number; per_challenge: { challenge_key: string; points: number; held: boolean }[] };
export type MyInvite = {
  invite_id: string;
  attempt_id: string | null;
  state: string;
  company_name: string;
  title: string;
  expires_at: string;
  time_limit_min: number | null;
  challenge_count: number;
  hints_mode: 'on' | 'off';
  hint_cost_pct: number;
  writeup_required: boolean;
  results_visibility: 'after_submit' | 'after_release';
};
export type InviteSummary = Omit<MyInvite, 'invite_id' | 'attempt_id'>;
export type ConsentNotice = { attempt_id: string; notice_version: string; notice_text: string; notice_text_sha256: string; retention_days_shown: number; company_name: string };
export type DeletionRequest = { request_id: string; kind: string; status: string; execute_after: string | null; can_undo: boolean; company_name: string | null; attempt_id: string | null };
export type DataView = { company_name: string; action: string; at: string };
export type MySession = { ref: string; created_at: string; last_seen_at: string; ip_trunc: string | null; ua_class: string | null; current: boolean };

// ---- the recruiter's shapes (IF-1 1.4.0, story P-27; the candidate's results are the lab's reviewer routes, IF-2) ----

export type CompanyStanding = {
  state: 'none' | 'unverified_email' | 'pending_approval' | 'active' | 'rejected' | 'suspended' | 'deleted';
  company_name: string | null;
  reason: string | null;
  terms_accepted: boolean;
  role: 'owner' | 'member' | null;
};
export type CompanyTerms = { version: string; text: string; sha256: string };
export type Template = {
  template_id: string;
  title: string;
  challenge_keys: string[];
  time_limit_min: number;
  hints_mode: 'on' | 'off';
  hint_cost_pct: number;
  reset_limit: number;
  invite_expiry_days: number;
  retention_days: number;
  writeup_required: boolean;
  results_visibility: 'after_submit' | 'after_release';
  flag_submissions_per_minute: number;
  version: number;
  updated_at: string;
};
export type CompanyInvite = {
  invite_id: string;
  template_id: string;
  email: string;
  state: string;
  attempt_id: string | null;
  generation: number;
  superseded_by: string | null;
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  consented_at: string | null;
  started_at: string | null;
  closed_at: string | null;
  time_limit_min: number | null;
  hints_mode: 'on' | 'off';
  hint_cost_pct: number;
};
export type InvitesResult = { created: CompanyInvite[]; skipped: { email: string; reason: string }[]; remaining: string[]; cap: number | null };
export type ReportChallenge = {
  challenge_key: string;
  best_milestone: string;
  points: number;
  held: boolean;
  hints_used: number;
  time_to_capture_seconds: number | null;
  technique_label: string | null;
};
export type Report = {
  attempt_id: string;
  state: string;
  score: number;
  elapsed_seconds: number | null;
  active_seconds: number | null;
  hints_used_total: number;
  integrity_open: number;
  per_challenge: ReportChallenge[];
};
export type Evidence = { evidence_id: string; challenge_key: string; captured_at: string; method: string; path: string; body: string | null; body_truncated: boolean };
export type IntegrityFlag = {
  integrity_flag_id: string;
  type: string;
  challenge_key: string | null;
  explanation: string;
  status: 'open' | 'accepted' | 'rejected';
  held: boolean;
  created_at: string;
  decision_note: string | null;
};
export type TimelineEntry = { at: string; type: string; challenge_key: string | null; milestone: string | null; result: string | null; minutes_left?: number };

/** One line of the timeline in words; a type this build does not know is shown as it is (IF-2 may add types). */
export function timelineText(t: TimelineEntry): string {
  const key = t.challenge_key ? ` ${t.challenge_key}` : '';
  switch (t.type) {
    case 'attempt.time_warning': return `Time warning: ${t.minutes_left ?? '?'} minutes left`;
    case 'attempt.started': return 'The clock started';
    case 'attempt.submitted': return 'Submitted';
    case 'attempt.expired': return 'Time ran out';
    case 'milestone.reached': return `Milestone${key}${t.milestone ? ` (${t.milestone})` : ''}`;
    case 'flag.submitted': return `Flag pasted${key}${t.result ? `: ${t.result}` : ''}`;
    case 'hint.unlocked': return `Hint unlocked${key}`;
    case 'instance.reset': return 'Instance reset';
    default: return `${t.type}${key}${t.milestone ? ` (${t.milestone})` : ''}${t.result ? `: ${t.result}` : ''}`;
  }
}

// ---- the admin's shapes (IF-1, story P-28; the dashboard is story P-30) ----

export type PendingCompany = { org_id: string; name: string; owner_name: string; owner_email_domain: string; applied_at: string };
export type AdminUser = {
  user_id: string;
  display_name: string;
  email: string;
  account_type: string;
  status: string;
  roles: string[];
  email_verified: boolean;
  last_login_at: string | null;
};
export type AdminSetting = { name: string; value: number | boolean | string; default: number | boolean | string; overridden: boolean; minimum: number | null; maximum: number | null };
export type Quota = { scope: 'user' | 'org' | 'global'; scope_id: string | null; max_instances: number };
export type Capacity = {
  instances: { running: number; reported: number; failed: number };
  memory: { capacity_mb: number; used_mb: number; health: string } | null;
  queue: { emails_waiting: number; events_unpublished: number };
  failures: { emails_failed: number; jobs_failed: number; instances_failed: number };
};
export type JobStatus = { name: string; interval_seconds: number; last_started_at: string | null; last_status: string | null; last_detail: string | null; next_due_at: string | null };

export type AuditEntry = { seq: number; at: string; actor: string; action: string; subject: string | null; details: Record<string, unknown> };
export type BreakGlassSession = {
  session_id: string;
  admin_id: string;
  admin_name: string;
  attempt_id: string;
  reason: string;
  started_at: string;
  expires_at: string;
  closed_at: string | null;
  reads: { at: string; what: string[] }[];
  reviewed_by: string | null;
  review_note: string | null;
  state: 'open' | 'over' | 'reviewed';
};

/** Seconds as "1h 02m 03s" (or "-"). */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The time warnings (story 2.3, FR-SES-03, FR-NTF-04), worked out from the deadline on the reader's clock: the minutes of the warning now in force, or null. The
 * thresholds are the engine's default rules (15 and 5 minutes, placeholders); the engine records each warning once in the attempt log (`time_warning_sent`). */
export const WARNING_MINUTES = [15, 5] as const;
export function timeWarning(secondsLeft: number | null | undefined): number | null {
  if (secondsLeft === null || secondsLeft === undefined || !Number.isFinite(secondsLeft) || secondsLeft <= 0) return null;
  let due: number | null = null;
  for (const m of WARNING_MINUTES) if (secondsLeft <= m * 60) due = m;
  return due;
}

/** "2026-10-20T10:00:00Z" as the reader's local date and time. */
export function when(stamp: string | null | undefined): string {
  if (!stamp) return '-';
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}
