// The rules of the learner and candidate screens that are not drawing: which attempt belongs on which screen, which challenge of a sequenced run is on stage,
// and the countdown arithmetic (the server's clock decides, the browser only draws it). Pure functions, so Node tests run them without a browser
// (apps/web/test/attempt-logic.test.mjs). Types only are imported, which keeps this file loadable by Node's type stripping.
import type { Attempt, AttemptSummary, ChallengeProgress, MyInvite, ProgressList } from './api';

export const TIER_MINUTES: Record<string, number> = { Easy: 20, Medium: 40, Hard: 60 };

/** Finished attempt states: nothing can run in them any more. */
export const FINISHED_STATES = ['submitted', 'reported', 'expired', 'cancelled', 'withdrawn', 'deleted'];
/** States of a run that can still be played or finished (a learner's run holds the learner's place while in them). */
export const LIVE_STATES = ['ready', 'running'];

// ---- mode: a candidate assessment is never shown as practice, a practice run never as an assessment ----

export type Mode = 'learner' | 'candidate';

/** Splits a list of the caller's attempts by `mode`. An entry without a known mode is in neither list: it is not guessed. */
export function splitByMode<T extends { mode?: string }>(attempts: readonly T[]): { practice: T[]; assessments: T[] } {
  return {
    practice: attempts.filter((a) => a.mode === 'learner'),
    assessments: attempts.filter((a) => a.mode === 'candidate'),
  };
}

/** The practice run to show: a live one first (ready, running), else the most recent finished one, else null. Never a candidate attempt. */
export function pickPracticeRun(attempts: readonly AttemptSummary[]): AttemptSummary | null {
  const practice = splitByMode(attempts).practice;
  const live = practice.find((a) => LIVE_STATES.includes(a.state));
  if (live) return live;
  return [...practice].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || 0)[0] ?? null;
}

/** The assessment to point a learner-only screen to: an unfinished one first. */
export function pickAssessment(attempts: readonly AttemptSummary[]): AttemptSummary | null {
  const list = splitByMode(attempts).assessments;
  return list.find((a) => !FINISHED_STATES.includes(a.state)) ?? list[0] ?? null;
}

/** Whether this attempt may be drawn on a screen made for `expected`. A mismatch gets a notice, not a board. */
export function modeMatches(attempt: Pick<Attempt, 'mode'>, expected: Mode): boolean {
  return attempt.mode === expected;
}

// ---- the clock ----

/** Server time minus the browser clock, in milliseconds (add it to Date.now() to get the server's now). 0 when the stamp is missing or not a date. */
export function skewMs(serverTime: string | null | undefined, browserNowMs: number): number {
  if (!serverTime) return 0;
  const t = Date.parse(serverTime);
  return Number.isNaN(t) ? 0 : t - browserNowMs;
}

/** Whole seconds until `until` on the server's clock (never negative), or null when there is no deadline. */
export function secondsLeft(until: string | null | undefined, browserNowMs: number, skew: number): number | null {
  if (!until) return null;
  const t = Date.parse(until);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - (browserNowMs + skew)) / 1000));
}

/** "mm:ss", or "h:mm:ss" from one hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** How urgent a countdown looks: calm, low (5 minutes or less), urgent (a minute or less). */
export function urgency(seconds: number | null): 'calm' | 'low' | 'urgent' {
  if (seconds === null) return 'calm';
  return seconds <= 60 ? 'urgent' : seconds <= 300 ? 'low' : 'calm';
}

// ---- a sequenced practice run ----

/** A sequenced run is recognised by what the server sent (IF-2 1.3.0): a `current_key`, a `total`, or a `state` on the entries. */
export function isSequenced(list: Pick<ProgressList, 'items' | 'current_key' | 'total'> | null | undefined): boolean {
  if (!list) return false;
  return list.current_key !== undefined || list.total !== undefined || list.items.some((i) => i.state !== undefined);
}

export type Phase = 'ready' | 'active' | 'solved' | 'expired';

/** The phase of one challenge. A server without sequencing sends no `state`: every challenge is then open (active), or solved. */
export function challengePhase(item: Pick<ChallengeProgress, 'state' | 'solved'>): Phase {
  return item.state ?? (item.solved ? 'solved' : 'active');
}

/** The challenge on stage: the one the learner picked on the rail, else `current_key`, else the first one not ended, else the last one. */
export function stageItem(list: Pick<ProgressList, 'items' | 'current_key'>, picked: string | null): ChallengeProgress | null {
  const by = (k: string | null | undefined) => (k ? list.items.find((i) => i.challenge_key === k) : undefined);
  return by(picked) ?? by(list.current_key) ?? list.items.find((i) => !i.solved && i.state !== 'expired') ?? list.items[list.items.length - 1] ?? null;
}

/** The seconds a challenge has once begun: what the server says, else the tier's time. */
export function challengeLimitSeconds(item: Pick<ChallengeProgress, 'time_limit_seconds' | 'tier'>): number {
  return item.time_limit_seconds || (TIER_MINUTES[item.tier ?? ''] ?? 40) * 60;
}

/**
 * Seconds left of the begun challenge on the server's clock. `expires_at` is exact; the answer's own `seconds_left` is only the fallback for the moment before the
 * first tick. null when the challenge is not active.
 */
export function challengeSecondsLeft(item: Pick<ChallengeProgress, 'state' | 'expires_at' | 'seconds_left'>, browserNowMs: number, skew: number): number | null {
  if (item.state !== 'active') return null;
  const exact = secondsLeft(item.expires_at, browserNowMs, skew);
  return exact ?? item.seconds_left ?? null;
}

/** Total shown as "n of N": how many challenges the run has (from `total`, else the catalogue length, else the list). */
export function runTotal(list: Pick<ProgressList, 'items' | 'total'>, catalogueLength: number): number {
  return list.total ?? (catalogueLength || list.items.length);
}

// ---- the candidate screens ----

const CLOSED_INVITE: Record<string, string> = {
  expired: 'This invitation has expired. Ask the company for a new one.',
  cancelled: 'The company cancelled this invitation.',
  revoked: 'The company withdrew this invitation.',
  declined: 'You declined this assessment.',
};

/** The sentence for an invitation that can no longer be used, or null while it can. */
export function closedInviteMessage(state: string): string | null {
  return CLOSED_INVITE[state] ?? null;
}

export type CandidateView = 'closed' | 'consent' | 'start' | 'preparing' | 'running' | 'submitted' | 'expired' | 'withdrawn' | 'gone';

/** What the candidate page shows for an invite and its attempt (the attempt may not be read yet). Decides one view, so the page never mixes two. */
export function candidateView(invite: Pick<MyInvite, 'state'>, attempt: Pick<Attempt, 'state'> | null): CandidateView {
  if (closedInviteMessage(invite.state)) return 'closed';
  if (invite.state === 'opened') return 'consent';
  if (!attempt) return 'start';
  switch (attempt.state) {
    case 'ready': return 'start';
    case 'running': return 'running';
    case 'submitted':
    case 'reported': return 'submitted';
    case 'expired': return 'expired';
    case 'withdrawn': return 'withdrawn';
    case 'cancelled':
    case 'deleted': return 'gone';
    default: return 'start';
  }
}

/** Results (score, points, report) may be shown to a candidate only after the attempt ended AND the invite allows it (OI-15; `results_released` once released). */
export function candidateResultsAllowed(attempt: Pick<Attempt, 'state' | 'results_released'>, visibility: MyInvite['results_visibility'] | undefined): boolean {
  if (!['submitted', 'reported', 'expired'].includes(attempt.state)) return false;
  return visibility === 'after_submit' || attempt.results_released === true;
}
