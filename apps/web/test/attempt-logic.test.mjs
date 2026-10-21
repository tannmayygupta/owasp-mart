// Work package E: the rules of the learner and candidate screens (apps/web/lib/attempt-logic.ts), run by Node directly (type stripping), no browser.
//   node --test apps/web/test/attempt-logic.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateResultsAllowed, candidateView, challengeLimitSeconds, challengePhase, challengeSecondsLeft, clock, closedInviteMessage, isSequenced, modeMatches,
  pickAssessment, pickPracticeRun, runTotal, secondsLeft, skewMs, splitByMode, stageItem, urgency,
} from '../lib/attempt-logic.ts';

const att = (id, mode, state, created = '2026-10-21T10:00:00Z') => ({ attempt_id: id, mode, state, instance_id: null, created_at: created, deadline_at: null });
const item = (key, extra = {}) => ({ challenge_key: key, best_milestone: 'none', solved: false, held: false, hints_used: 0, hints_available: true, ...extra });

// ---- the clock ----
test('skew is the server time minus the browser clock; a missing or broken stamp is no skew', () => {
  assert.equal(skewMs('2026-10-21T10:00:10Z', Date.parse('2026-10-21T10:00:00Z')), 10_000);
  assert.equal(skewMs('2026-10-21T09:59:50Z', Date.parse('2026-10-21T10:00:00Z')), -10_000);
  assert.equal(skewMs(undefined, 1), 0);
  assert.equal(skewMs('not a date', 1), 0);
});

test('seconds left use the server clock: a browser that runs 10 s behind still counts down to the server deadline', () => {
  const serverNow = Date.parse('2026-10-21T10:00:10Z');
  const browserNow = Date.parse('2026-10-21T10:00:00Z');
  const skew = serverNow - browserNow;
  assert.equal(secondsLeft('2026-10-21T10:01:00Z', browserNow, skew), 50);
  assert.equal(secondsLeft('2026-10-21T10:01:00Z', browserNow, 0), 60, 'without the skew the browser would be 10 s off');
  assert.equal(secondsLeft('2026-10-21T10:01:00Z', browserNow + 70_000, skew), 0, 'never negative');
  assert.equal(secondsLeft(null, 0, 0), null);
  assert.equal(secondsLeft('garbage', 0, 0), null);
});

test('the clock reads mm:ss, and h:mm:ss from an hour', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(65), '01:05');
  assert.equal(clock(1199.4), '19:59');
  assert.equal(clock(3600), '1:00:00');
  assert.equal(clock(-5), '00:00');
});

test('urgency turns low at five minutes and urgent at one', () => {
  assert.deepEqual([null, 1000, 300, 61, 60, 0].map(urgency), ['calm', 'calm', 'low', 'low', 'urgent', 'urgent']);
});

// ---- mode: practice and assessment never mix ----
test('a candidate attempt is never in the practice list and a practice run never in the assessments', () => {
  const all = [att('a-1', 'candidate', 'running'), att('a-2', 'learner', 'submitted'), att('a-3', 'candidate', 'ready'), { attempt_id: 'a-4', state: 'running' }];
  const { practice, assessments } = splitByMode(all);
  assert.deepEqual(practice.map((a) => a.attempt_id), ['a-2']);
  assert.deepEqual(assessments.map((a) => a.attempt_id), ['a-1', 'a-3']);
});

test('the practice run to show is a live learner run, else the latest learner run, never a candidate attempt', () => {
  assert.equal(pickPracticeRun([att('c', 'candidate', 'running')]), null, 'only an assessment: no practice run');
  assert.equal(pickPracticeRun([att('old', 'learner', 'submitted', '2026-10-01T00:00:00Z'), att('live', 'learner', 'running', '2026-09-01T00:00:00Z')]).attempt_id, 'live');
  assert.equal(pickPracticeRun([att('old', 'learner', 'submitted', '2026-10-01T00:00:00Z'), att('new', 'learner', 'expired', '2026-10-05T00:00:00Z')]).attempt_id, 'new');
  assert.equal(pickPracticeRun([att('c', 'candidate', 'running'), att('l', 'learner', 'ready')]).attempt_id, 'l');
  assert.equal(pickPracticeRun([]), null);
});

test('the assessment to point to prefers an unfinished one', () => {
  assert.equal(pickAssessment([att('done', 'candidate', 'submitted'), att('open', 'candidate', 'ready')]).attempt_id, 'open');
  assert.equal(pickAssessment([att('l', 'learner', 'running')]), null);
});

test('an attempt is drawn only on the screen of its own mode', () => {
  assert.equal(modeMatches({ mode: 'candidate' }, 'candidate'), true);
  assert.equal(modeMatches({ mode: 'candidate' }, 'learner'), false);
  assert.equal(modeMatches({ mode: 'learner' }, 'candidate'), false);
});

// ---- the sequenced run ----
test('a run is sequenced when the server sends current_key, total or a state on an entry; an old list is not', () => {
  assert.equal(isSequenced({ items: [item('C01')] }), false);
  assert.equal(isSequenced({ items: [item('C01')], current_key: 'C01' }), true);
  assert.equal(isSequenced({ items: [], total: 11, current_key: null }), true);
  assert.equal(isSequenced({ items: [item('C01', { state: 'ready' })] }), true);
  assert.equal(isSequenced(null), false);
});

test('the phase of a challenge comes from its state; without a state it is open or solved', () => {
  assert.equal(challengePhase(item('C01', { state: 'expired' })), 'expired');
  assert.equal(challengePhase(item('C01')), 'active');
  assert.equal(challengePhase(item('C01', { solved: true })), 'solved');
});

test('the stage shows the picked challenge, else current_key, else the first not ended, else the last', () => {
  const list = { items: [item('C01', { state: 'solved', solved: true }), item('C02', { state: 'active' })], current_key: 'C02' };
  assert.equal(stageItem(list, null).challenge_key, 'C02');
  assert.equal(stageItem(list, 'C01').challenge_key, 'C01', 'a picked one wins');
  assert.equal(stageItem(list, 'C09').challenge_key, 'C02', 'a picked key that is not listed (a future challenge) is ignored');
  const finished = { items: [item('C01', { state: 'solved', solved: true }), item('C02', { state: 'expired' })], current_key: null };
  assert.equal(stageItem(finished, null).challenge_key, 'C02', 'everything ended: the last one');
  assert.equal(stageItem({ items: [item('C01', { solved: true }), item('C02')] }, null).challenge_key, 'C02', 'not sequenced: the first not solved');
  assert.equal(stageItem({ items: [], current_key: null }, null), null);
});

test('the countdown of a begun challenge is exact from expires_at on the server clock; others have none', () => {
  const browser = Date.parse('2026-10-21T10:00:00Z');
  const active = { state: 'active', expires_at: '2026-10-21T10:10:00Z', seconds_left: 999 };
  assert.equal(challengeSecondsLeft(active, browser, 0), 600);
  assert.equal(challengeSecondsLeft(active, browser, 30_000), 570, 'server ahead of the browser by 30 s');
  assert.equal(challengeSecondsLeft({ state: 'active', expires_at: null, seconds_left: 1195 }, browser, 0), 1195, 'fallback to the answer\'s own seconds_left');
  assert.equal(challengeSecondsLeft({ state: 'ready', expires_at: null, seconds_left: 1200 }, browser, 0), null);
  assert.equal(challengeSecondsLeft({ state: 'solved', expires_at: '2026-10-21T10:10:00Z' }, browser, 0), null);
});

test('the time a challenge has: the server\'s number, else by tier (20, 40, 60 minutes)', () => {
  assert.equal(challengeLimitSeconds({ time_limit_seconds: 1200 }), 1200);
  assert.equal(challengeLimitSeconds({ tier: 'Hard' }), 3600);
  assert.equal(challengeLimitSeconds({ tier: 'Easy' }), 1200);
  assert.equal(challengeLimitSeconds({}), 2400);
});

test('the total of a run: the server\'s total, else the catalogue, else the list', () => {
  assert.equal(runTotal({ items: [item('C01')], total: 11 }, 3), 11);
  assert.equal(runTotal({ items: [item('C01')] }, 3), 3);
  assert.equal(runTotal({ items: [item('C01')] }, 0), 1);
});

// ---- the candidate screens ----
test('a closed invitation has its own sentence; an open one has none', () => {
  for (const s of ['expired', 'cancelled', 'revoked', 'declined']) assert.ok(closedInviteMessage(s), s);
  assert.match(closedInviteMessage('expired'), /expired/);
  assert.equal(closedInviteMessage('consented'), null);
});

test('the candidate page decides one view from the invite and the attempt', () => {
  assert.equal(candidateView({ state: 'expired' }, null), 'closed');
  assert.equal(candidateView({ state: 'opened' }, null), 'consent');
  assert.equal(candidateView({ state: 'consented' }, { state: 'ready' }), 'start');
  assert.equal(candidateView({ state: 'started' }, { state: 'running' }), 'running');
  assert.equal(candidateView({ state: 'started' }, { state: 'submitted' }), 'submitted');
  assert.equal(candidateView({ state: 'started' }, { state: 'expired' }), 'expired');
  assert.equal(candidateView({ state: 'started' }, { state: 'withdrawn' }), 'withdrawn');
  assert.equal(candidateView({ state: 'started' }, { state: 'cancelled' }), 'gone');
});

test('results reach a candidate only after the attempt ended and only if the invite or the recruiter allows', () => {
  assert.equal(candidateResultsAllowed({ state: 'running' }, 'after_submit'), false, 'never while running');
  assert.equal(candidateResultsAllowed({ state: 'submitted' }, 'after_submit'), true);
  assert.equal(candidateResultsAllowed({ state: 'submitted' }, 'after_release'), false, 'held until the recruiter releases');
  assert.equal(candidateResultsAllowed({ state: 'submitted', results_released: true }, 'after_release'), true);
  assert.equal(candidateResultsAllowed({ state: 'expired', results_released: false }, 'after_release'), false);
  assert.equal(candidateResultsAllowed({ state: 'submitted' }, undefined), false);
});