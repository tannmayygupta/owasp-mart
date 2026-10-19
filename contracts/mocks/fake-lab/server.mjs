// Fake lab API (IF-2): a stateful, dependency-free Node service that answers every operation of
// contracts/api/lab/lab.openapi.yaml, so the dashboards can be built without the real platform. It is NOT the real API.
//
// What it does: cookie session, CSRF header and Origin checks on POST, JSON only, ownership (a missing and a not-yours resource
// give the same 404), flag results by input, a flag rate limit, hints, instance state rules, a small in-memory state.
// What it never does: answer a flag, decoy, digest, seed, key, owner hash, host id or stack trace; echo or store a submitted flag.
// The only flag-looking strings in this file are four obviously fake test values (one repeated letter) that decide the result.
//
// Fake sessions (cookie __Host-vm_session): FAKE-SESSION-ADA (learner), FAKE-SESSION-CAM (candidate), FAKE-SESSION-REX
// (recruiter of the company that owns the candidate attempt), FAKE-SESSION-EVE (another learner). CSRF: the header X-CSRF-Token
// must equal the cookie __Host-vm_csrf. Origin must equal --origin.
// Seed: a-AAAAAAAAAAAAAAAA (ada, learner, running, no instance), a-BBBBBBBBBBBBBBBB (cam, candidate, running, hints off,
// instance i-BBBBBBBBBBBBBBBB ready), a-CCCCCCCCCCCCCCCC (cam, candidate, ready), a-DDDDDDDDDDDDDDDD (cam, candidate, submitted).
// Test flags: correct, decoy, other_instance and stale_epoch are "VM{" + 24 times A, B, C and D + "}". Anything else is wrong.
// Mock rule (not part of the contract): a correct flag for C11 in a candidate attempt is held, not credited.
// Seed attempts in the states a platform action leaves behind: a-EEEEEEEEEEEEEEEE withdrawn, a-FFFFFFFFFFFFFFFF cancelled,
// a-GGGGGGGGGGGGGGGG deleted (all candidate attempts of cam in org-1; reads of them follow lab-api.md section 4, a proposal to confirm).
// Test hook (not part of the contract, no session needed, meant for a test on the same machine): POST /_fake/late-event with
// {"attempt_id", "epoch", "seq", "type"?, "challenge_key"?, "milestone"?, "result"?} stores one timeline event under that key, as a late
// event of IF-4 would arrive (older key than events already shown). Answers 204; 409 when the key exists; 422 or 404 on a bad body.
// The detailed reason of a flag result is kept server side only (the array `reasonLog` of createFakeLab, and a JSON line on stderr).
//
// Usage: node server.mjs [--port 0] [--host 127.0.0.1] [--origin https://dashboard.example.invalid] [--step-delay-ms 0]
// Prints {"listening":true,"port":N} when ready. State is in memory; restart to reset.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_TYPE, problemBody } from '../shared/problem.mjs';

export const MAX_BODY = 64 * 1024;
const DRAIN_CAP = 1024 * 1024;
const SESSION_COOKIE = '__Host-vm_session';
const CSRF_COOKIE = '__Host-vm_csrf';
const KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];
const WEIGHT = 90;
const SHARE = [0, 0.2, 0.4, 1];
const MILESTONES = ['none', 'M1', 'M2', 'M3'];
const HINT_KINDS = ['nudge', 'direction', 'near_solution'];
const WRONG_LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const FAKE = (c) => 'VM{' + c.repeat(24) + '}';
const RESULT_BY_FLAG = new Map([[FAKE('A'), 'correct'], [FAKE('B'), 'decoy'], [FAKE('C'), 'other_instance'], [FAKE('D'), 'stale_epoch']]);
const RE = {
  instance: /^i-[A-Z2-7]{16}$/, attempt: /^a-[A-Z2-7]{16}$/, flagId: /^g-[A-Z2-7]{16}$/,
  challenge: /^C(0[1-9]|10|11)$/, cursor: /^[A-Za-z0-9_-]{1,128}$/,
};
const SEQ_STEP = 1000; // the mock leaves gaps between sequence numbers, like the separate lanes of IF-4 do
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const USERS = {
  'FAKE-SESSION-ADA': { id: 'ada', role: 'learner', org: null },
  'FAKE-SESSION-CAM': { id: 'cam', role: 'candidate', org: null },
  'FAKE-SESSION-REX': { id: 'rex', role: 'recruiter', org: 'org-1' },
  'FAKE-SESSION-EVE': { id: 'eve', role: 'learner', org: null },
};

export function createFakeLab(options = {}) {
  const cfg = { host: '127.0.0.1', port: 0, origin: 'https://dashboard.example.invalid', stepDelayMs: 0, drainStallMs: 5000, ...options };
  let idCounter = 0;
  const newId = (prefix) => {
    let n = ++idCounter + 5000;
    let s = '';
    for (let i = 0; i < 16; i++) { s = ALPHABET[n % 32] + s; n = Math.floor(n / 32); }
    return prefix + '-' + s;
  };
  const attempts = new Map();
  const instances = new Map();

  function makeAttempt(id, ownerId, mode, orgId, state, hintsEnabled) {
    const progress = new Map(KEYS.map((k) => [k, { best: 0, held: false, hints: new Set() }]));
    const a = { id, ownerId, mode, orgId, state, hintsEnabled, instanceId: null, startedAt: null, deadlineAt: null, submittedAt: null,
      frozenUntil: null, progress, submissions: [], integrity: [], evidence: [], timeline: [], tlSeq: new Map() };
    attempts.set(id, a);
    return a;
  }
  function makeInstance(id, attempt, state, access, health) {
    const now = stamp();
    const r = { id, attemptId: attempt.id, ownerId: attempt.ownerId, state, access, health, epoch: 1, errorCode: null,
      requestedAt: now, readyAt: state === 'ready' ? now : null, expiresAt: stamp(Date.now() + 4 * 3600 * 1000), updatedAt: now, timer: null };
    instances.set(id, r);
    attempt.instanceId = id;
    return r;
  }
  // A timeline event has a key (epoch, seq) that the answer never shows; it only orders the events and makes the cursor. The epoch is the
  // instance epoch when the event is stored; a late event is stored under the key it carries.
  function addTimeline(a, entry, key) {
    const epoch = key?.epoch ?? (a.instanceId ? instances.get(a.instanceId)?.epoch : undefined) ?? 1;
    const seq = key?.seq ?? (a.tlSeq.get(epoch) ?? 0) + SEQ_STEP;
    a.tlSeq.set(epoch, Math.max(a.tlSeq.get(epoch) ?? 0, seq));
    a.timeline.push({ ...entry, epoch, seq });
  }
  const reasonLog = [];
  function seed() {
    makeAttempt('a-AAAAAAAAAAAAAAAA', 'ada', 'learner', null, 'running', true);
    const b = makeAttempt('a-BBBBBBBBBBBBBBBB', 'cam', 'candidate', 'org-1', 'running', false);
    b.startedAt = stamp(Date.now() - 40 * 60 * 1000);
    b.deadlineAt = stamp(Date.now() + 80 * 60 * 1000);
    makeInstance('i-BBBBBBBBBBBBBBBB', b, 'ready', 'open', 'healthy');
    b.progress.get('C01').best = 2;
    b.progress.get('C11').held = true;
    addTimeline(b, { at: b.startedAt, type: 'attempt.started', challenge_key: null, milestone: null, result: null });
    addTimeline(b, { at: stamp(Date.now() - 30 * 60 * 1000), type: 'milestone.reached', challenge_key: 'C01', milestone: 'M1', result: null });
    addTimeline(b, { at: stamp(Date.now() - 20 * 60 * 1000), type: 'milestone.reached', challenge_key: 'C01', milestone: 'M2', result: null });
    b.evidence.push({ evidence_id: 'e-AAAAAAAAAAAAAAAA', challenge_key: 'C01', captured_at: stamp(Date.now() - 20 * 60 * 1000), method: 'GET',
      path: '/api/orders/1001', body: null, body_truncated: false });
    b.integrity.push({ id: 'g-AAAAAAAAAAAAAAAA', type: 'timing', challenge: 'C01', explanation: 'The capture came sooner than the plausible minimum time.',
      status: 'open', held: false, createdAt: stamp(Date.now() - 19 * 60 * 1000), decidedAt: null, note: null });
    b.integrity.push({ id: 'g-BBBBBBBBBBBBBBBB', type: 'activity', challenge: 'C11', explanation: 'The capture does not match the recorded activity; it is held for review.',
      status: 'open', held: true, createdAt: stamp(Date.now() - 10 * 60 * 1000), decidedAt: null, note: null });
    makeAttempt('a-CCCCCCCCCCCCCCCC', 'cam', 'candidate', 'org-1', 'ready', false);
    const d = makeAttempt('a-DDDDDDDDDDDDDDDD', 'cam', 'candidate', 'org-1', 'submitted', false);
    d.startedAt = stamp(Date.now() - 3 * 3600 * 1000);
    d.deadlineAt = stamp(Date.now() - 1 * 3600 * 1000);
    d.submittedAt = stamp(Date.now() - 70 * 60 * 1000);
    d.frozenUntil = stamp(Date.now() - 55 * 60 * 1000);
    const e = makeAttempt('a-EEEEEEEEEEEEEEEE', 'cam', 'candidate', 'org-1', 'withdrawn', false);
    e.deleteAfter = stamp(Date.now() + 7 * 24 * 3600 * 1000);
    makeAttempt('a-FFFFFFFFFFFFFFFF', 'cam', 'candidate', 'org-1', 'cancelled', false);
    makeAttempt('a-GGGGGGGGGGGGGGGG', 'cam', 'candidate', 'org-1', 'deleted', false);
  }
  seed();

  // ---- responses ----
  const send = (res, status, body, type = 'application/json', extra = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text), 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', ...extra });
    res.end(text);
  };
  // The IF-8 error body (shared/problem.mjs): title and status come from the registry, no `detail`, no `instance`, and `field` only on a 422.
  // `message` is a note for the reader of this file; it never reaches the answer.
  const problem = (res, status, code, message, field, extra = {}) => {
    const requestId = 'req-' + crypto.randomBytes(6).toString('hex');
    const body = problemBody(code, requestId, { field });
    send(res, body.status, body, MEDIA_TYPE, extra);
  };
  const invalid = (res, field, message) => problem(res, 422, 'REQ-VALIDATION', message, field);
  const attemptNotFound = (res) => problem(res, 404, 'ATT-NOT-FOUND', 'no such attempt');
  const instanceNotFound = (res) => problem(res, 404, 'INST-NOT-FOUND', 'no such instance');

  // ---- views ----
  const instanceView = (r) => ({ instance_id: r.id, attempt_id: r.attemptId, state: r.state, access: r.access, health: r.health, epoch: r.epoch,
    error_code: r.errorCode, requested_at: r.requestedAt, ready_at: r.readyAt, expires_at: r.expiresAt, updated_at: r.updatedAt });
  const attemptView = (a) => ({ attempt_id: a.id, mode: a.mode, state: a.state, hints_enabled: a.hintsEnabled, instance_id: a.instanceId,
    started_at: a.startedAt, deadline_at: a.deadlineAt, submitted_at: a.submittedAt, frozen_until: a.frozenUntil,
    delete_after: a.state === 'withdrawn' ? (a.deleteAfter ?? null) : null, server_time: stamp() });
  const costPct = (a, level) => (a.mode === 'candidate' ? level * 10 : 0);
  const hintText = (key, level) => `Fake hint level ${level} for ${key} (mock text, not a real hint).`;
  function points(a, key) {
    const p = a.progress.get(key);
    const raw = WEIGHT * SHARE[p.best];
    let cost = 0;
    if (a.hintsEnabled) for (const l of p.hints) cost += (WEIGHT * costPct(a, l)) / 100;
    return Math.max(0, Math.round(raw - cost));
  }
  const total = (a) => Math.round((1000 * KEYS.reduce((n, k) => n + points(a, k), 0)) / (KEYS.length * WEIGHT));
  const scoreRows = (a) => KEYS.map((k) => { const p = a.progress.get(k);
    return { challenge_key: k, best_milestone: MILESTONES[p.best], held: p.held, hints_used: p.hints.size, points: points(a, k) }; });
  const timelineView = (e) => ({ at: e.at, type: e.type, challenge_key: e.challenge_key, milestone: e.milestone, result: e.result });
  const GONE_STATES = ['withdrawn', 'cancelled'];
  const flagView = (f) => ({ integrity_flag_id: f.id, type: f.type, challenge_key: f.challenge, explanation: f.explanation, status: f.status,
    held: f.held, created_at: f.createdAt, decided_at: f.decidedAt, decision_note: f.note });

  // ---- access rules ----
  const isReviewer = (u, a) => (a.mode === 'learner' && a.ownerId === u.id) || (a.orgId !== null && u.role === 'recruiter' && u.org === a.orgId);
  // The owner of a learner attempt is a reviewer too, but must not learn why a submitted value was not correct (no oracle): the flags of type
  // decoy and sharing are for a recruiter only.
  const flagsFor = (u, a) => a.integrity.filter((f) => u.role === 'recruiter' || (f.type !== 'decoy' && f.type !== 'sharing'));
  const canRead = (u, a) => a.ownerId === u.id || isReviewer(u, a);

  // ---- instance state machine (a stand-in for the orchestrator) ----
  function move(r, state, extra = {}) {
    r.state = state;
    Object.assign(r, extra);
    r.updatedAt = stamp();
  }
  function schedule(r) {
    clearTimeout(r.timer);
    const next = { requested: 'provisioning', resetting: 'provisioning', provisioning: 'starting', starting: 'ready', stopping: 'destroyed' }[r.state];
    if (!next) return;
    r.timer = setTimeout(() => {
      if (next === 'ready') move(r, 'ready', { health: 'healthy', access: attempts.get(r.attemptId)?.state === 'running' ? 'open' : r.access, readyAt: stamp() });
      else if (next === 'destroyed') move(r, 'destroyed', { access: 'closed' });
      else move(r, next);
      schedule(r);
    }, cfg.stepDelayMs);
    r.timer.unref?.();
  }

  // ---- request helpers ----
  // An oversize body is refused with 413 at once, with `Connection: close`. The rest of the body is read and thrown away, so the client can
  // finish sending and read the 413 (closing at once would reset the connection before the answer is read). The socket is destroyed when the
  // body ends (after the answer is out), when more than DRAIN_CAP has arrived, or after 5 seconds without the end (lab-api.md, order of checks).
  function drain(req, res, already = 0) {
    const closeAfterAnswer = () => {
      if (res.writableEnded && !res.writableFinished) res.once('finish', () => req.socket.destroy());
      else req.socket.destroy();
    };
    if (req.readableEnded || req.complete) return closeAfterAnswer();
    let seen = already;
    const timer = setTimeout(() => req.socket.destroy(), cfg.drainStallMs);
    timer.unref?.();
    req.on('data', (c) => { seen += c.length; if (seen > DRAIN_CAP) { clearTimeout(timer); req.socket.destroy(); } });
    req.on('end', () => { clearTimeout(timer); closeAfterAnswer(); });
    req.on('close', () => clearTimeout(timer));
    req.resume();
  }  function readBody(req, res) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > MAX_BODY) { drain(req, res); return resolve({ tooLarge: true, buf: Buffer.alloc(0) }); }
      const chunks = [];
      let size = 0;
      const onData = (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.off('data', onData); drain(req, res, size); return resolve({ tooLarge: true, buf: Buffer.alloc(0) }); }
        chunks.push(c);
      };
      req.on('data', onData);
      req.on('end', () => resolve({ tooLarge: false, buf: Buffer.concat(chunks) }));
      req.on('error', reject);
    });
  }
  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  // Returns { ok: true, body } or { ok: false } after answering. `mode`: 'none' (no body allowed) or 'json' (an object).
  function parseBody(res, buf, mode, req) {
    if (mode === 'none') {
      if (buf.length > 0) { invalid(res, '', 'this call takes no body'); return { ok: false }; }
      return { ok: true, body: null };
    }
    let body;
    try { body = JSON.parse(buf.toString('utf8')); } catch { invalid(res, '', 'the body is not valid JSON'); return { ok: false }; }
    if (!isObj(body)) { invalid(res, '', 'the body must be a JSON object'); return { ok: false }; }
    return { ok: true, body };
  }
  // The names of unknown keys are echoed only when they are plain; values are never echoed.
  function checkKeys(res, body, allowed) {
    for (const k of Object.keys(body)) {
      if (!allowed.includes(k)) { invalid(res, /^[A-Za-z0-9_-]{1,64}$/.test(k) ? '/' + k : '', 'unknown field'); return false; }
    }
    for (const k of allowed) if (!(k in body)) { invalid(res, '/' + k, `${k} is required`); return false; }
    return true;
  }

  // A GET takes only the listed query parameters, each at most once. Returns the parameters, or null after answering 422.
  function queryOf(res, url, allowed) {
    const q = url.searchParams;
    const pointer = (name) => { const s = name.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, ''); return s === name && s !== '' ? '/' + s : ''; };
const queryPointer = (name) => (pointer(name) === '' ? '' : '/query' + pointer(name));
    for (const name of q.keys()) if (!allowed.includes(name)) { invalid(res, queryPointer(name), 'unknown query parameter'); return null; }
    for (const name of new Set(q.keys())) if (q.getAll(name).length > 1) { invalid(res, queryPointer(name), 'a query parameter is given more than once'); return null; }
    return q;
  }

  // `limit` is a plain whole number from 1 to `max`. Returns it (or `dflt`), or null after answering 422.
  function parseLimit(res, q, dflt, max) {
    if (!q.has('limit')) return dflt;
    const t = q.get('limit');
    if (!/^[1-9][0-9]{0,2}$/.test(t) || Number(t) > max) { invalid(res, '/query/limit', `limit is 1 to ${max}`); return null; }
    return Number(t);
  }

  // ---- handlers; each gets ({ res, user, params, body, url }) ----
  const H = {};
  H.requestInstance = ({ res, user, take }) => {
    const body = take();
    if (body === false || !checkKeys(res, body, ['kind'])) return;
    if (body.kind !== 'learner') return invalid(res, '/kind', 'kind must be learner');
    for (const r of instances.values()) {
      if (r.ownerId === user.id && r.state !== 'destroyed') return problem(res, 409, 'INST-QUOTA-REACHED', 'you already hold an instance');
    }
    let a = [...attempts.values()].find((x) => x.ownerId === user.id && x.mode === 'learner' && x.state === 'running' && x.instanceId === null);
    if (!a) {
      a = makeAttempt(newId('a'), user.id, 'learner', null, 'running', true);
      a.startedAt = stamp();
    }
    const r = makeInstance(newId('i'), a, 'requested', 'closed', 'unknown');
    const view = instanceView(r);
    schedule(r);
    send(res, 202, view);
  };
  const ownInstance = (res, user, id) => {
    const r = RE.instance.test(id) ? instances.get(id) : undefined;
    if (!r || r.ownerId !== user.id) { instanceNotFound(res); return null; }
    return r;
  };
  H.getInstance = ({ res, user, params, url }) => { const r = ownInstance(res, user, params.instance_id); if (r && queryOf(res, url, [])) send(res, 200, instanceView(r)); };
  H.openInstance = ({ res, user, params, take }) => {
    const r = ownInstance(res, user, params.instance_id);
    if (!r || take() === false) return;
    if (!['ready', 'active', 'idle'].includes(r.state) || r.access !== 'open') return problem(res, 409, 'INST-NOT-READY', 'the instance is not ready to open');
    const ticket = crypto.randomBytes(32).toString('base64url') + '.' + crypto.randomBytes(32).toString('base64url'); // payload.signature (gate-ticket.md)
    send(res, 200, { url: `https://${r.id.toLowerCase()}.labs.example.invalid/_vm/enter?t=${ticket}`, expires_at: stamp(Date.now() + 60 * 1000) });
  };
  const canChange = (r) => r.access !== 'frozen' && attempts.get(r.attemptId)?.state === 'running';
  H.resetInstance = ({ res, user, params, take }) => {
    const r = ownInstance(res, user, params.instance_id);
    if (!r) return;
    const body = take();
    if (body === false || !checkKeys(res, body, ['confirm'])) return;
    if (body.confirm !== true) return invalid(res, '/confirm', 'confirm must be true');
    if (!['ready', 'active', 'idle'].includes(r.state)) return problem(res, 409, 'INST-INVALID-STATE', `reset is not allowed in state ${r.state}`);
    if (!canChange(r)) return problem(res, 409, 'INST-INVALID-STATE', 'the instance is frozen or its attempt is not running');
    r.epoch += 1;
    move(r, 'resetting', { health: 'unknown', readyAt: null });
    const a = attempts.get(r.attemptId);
    addTimeline(a, { at: r.updatedAt, type: 'instance.reset', challenge_key: null, milestone: null, result: null });
    const view = instanceView(r);
    schedule(r);
    send(res, 202, view);
  };
  H.stopInstance = ({ res, user, params, take }) => {
    const r = ownInstance(res, user, params.instance_id);
    if (!r || take() === false) return;
    if (r.state === 'stopping' || r.state === 'destroyed') return send(res, 200, instanceView(r));
    if (!canChange(r)) return problem(res, 409, 'INST-INVALID-STATE', 'the instance is frozen or its attempt is not running');
    move(r, 'stopping');
    const view = instanceView(r);
    schedule(r);
    send(res, 202, view);
  };
  // A deleted attempt is the same 404 as a missing one (proposal, to confirm).
  const findAttempt = (res, id) => { const a = RE.attempt.test(id) ? attempts.get(id) : undefined; if (!a || a.state === 'deleted') { attemptNotFound(res); return undefined; } return a; };
  // A withdrawn or cancelled attempt is still readable as itself (getAttempt); its derived data is 410 (proposal, to confirm).
  const gone = (res, a) => { if (!GONE_STATES.includes(a.state)) return false; problem(res, 410, 'ATT-GONE', `the attempt is ${a.state}; its data is no longer available`); return true; };
  const readableState = (res, user, id) => { const a = findAttempt(res, id); if (!a) return null; if (!canRead(user, a)) { attemptNotFound(res); return null; } return a; };
  const readable = (res, user, id) => { const a = readableState(res, user, id); return a && !gone(res, a) ? a : null; };
  const owned = (res, user, id) => { const a = findAttempt(res, id); if (!a) return null; if (a.ownerId !== user.id) { attemptNotFound(res); return null; } return a; };
  const reviewable = (res, user, id) => { const a = findAttempt(res, id); if (!a) return null; if (!isReviewer(user, a)) { attemptNotFound(res); return null; } return gone(res, a) ? null : a; };

  H.getAttempt = ({ res, user, params, url }) => { const a = readableState(res, user, params.attempt_id); if (a && queryOf(res, url, [])) send(res, 200, attemptView(a)); };
  H.startAttempt = ({ res, user, params, take }) => {
    const a = owned(res, user, params.attempt_id);
    if (!a || take() === false) return;
    if (a.state !== 'ready') return problem(res, 409, 'ATT-INVALID-STATE', `start is not allowed in state ${a.state}`);
    a.state = 'running';
    a.startedAt = stamp();
    a.deadlineAt = stamp(Date.now() + 120 * 60 * 1000);
    addTimeline(a, { at: a.startedAt, type: 'attempt.started', challenge_key: null, milestone: null, result: null });
    send(res, 200, attemptView(a));
  };
  H.submitAttempt = ({ res, user, params, take }) => {
    const a = owned(res, user, params.attempt_id);
    if (!a) return;
    const body = take();
    if (body === false || !checkKeys(res, body, ['confirm'])) return;
    if (body.confirm !== true) return invalid(res, '/confirm', 'confirm must be true');
    if (a.state !== 'running') return problem(res, 409, 'ATT-INVALID-STATE', `submit is not allowed in state ${a.state}`);
    a.state = 'submitted';
    a.submittedAt = stamp();
    a.frozenUntil = stamp(Date.now() + 15 * 60 * 1000);
    addTimeline(a, { at: a.submittedAt, type: 'attempt.submitted', challenge_key: null, milestone: null, result: null });
    const r = a.instanceId ? instances.get(a.instanceId) : null;
    if (r && r.state !== 'destroyed') { r.access = 'frozen'; r.updatedAt = stamp(); }
    send(res, 200, attemptView(a));
  };
  const WITHDRAWABLE = ['ready', 'running', 'submitted'];
  H.withdrawAttempt = ({ res, user, params, take }) => {
    const a = owned(res, user, params.attempt_id);
    if (!a) return;
    const body = take();
    if (body === false || !checkKeys(res, body, ['confirm'])) return;
    if (body.confirm !== true) return invalid(res, '/confirm', 'confirm must be true');
    if (a.mode !== 'candidate') return problem(res, 409, 'ATT-INVALID-STATE', 'only a candidate attempt can be withdrawn');
    if (a.state === 'withdrawn') return send(res, 200, attemptView(a));
    if (!WITHDRAWABLE.includes(a.state)) return problem(res, 409, 'ATT-INVALID-STATE', `withdraw is not allowed in state ${a.state}`);
    a.state = 'withdrawn';
    a.deleteAfter = stamp(Date.now() + 7 * 24 * 3600 * 1000);
    const r = a.instanceId ? instances.get(a.instanceId) : null;
    if (r && r.state !== 'destroyed') { r.state = 'destroyed'; r.access = 'closed'; r.updatedAt = stamp(); }
    send(res, 200, attemptView(a));
  };
  H.undoWithdrawal = ({ res, user, params, take }) => {
    const a = owned(res, user, params.attempt_id);
    if (!a || take() === false) return;
    if (a.mode !== 'candidate' || a.state !== 'withdrawn') return problem(res, 409, 'ATT-INVALID-STATE', 'only a withdrawn attempt can be restored');
    if (a.deleteAfter && Date.parse(a.deleteAfter) <= Date.now()) return problem(res, 410, 'ATT-GONE', 'the undo window has closed');
    a.deleteAfter = null;
    send(res, 200, attemptView(a));
  };
  H.submitFlag = ({ res, user, params, take }) => {
    const a = owned(res, user, params.attempt_id);
    if (!a) return;
    const body = take();
    if (body === false || !checkKeys(res, body, ['challenge_key', 'flag'])) return;
    if (typeof body.challenge_key !== 'string' || !RE.challenge.test(body.challenge_key)) return invalid(res, '/challenge_key', 'bad challenge key');
    if (typeof body.flag !== 'string' || body.flag.length < 1 || body.flag.length > 200) return invalid(res, '/flag', 'flag is text of 1 to 200 characters');
    if (a.state !== 'running') return problem(res, 409, 'ATT-INVALID-STATE', `a flag cannot be submitted in state ${a.state}`);
    const key = body.challenge_key;
    const now = Date.now();
    // Only the result is kept, never the text. The submitter is told `correct` or `incorrect` (no oracle); the reason stays on the server.
    const reason = RESULT_BY_FLAG.get(body.flag) ?? 'wrong';
    const result = reason === 'correct' ? 'correct' : 'incorrect';
    const p = a.progress.get(key);
    // A correct value for a challenge that is already credited, or already held with an open flag, answers the same again and records nothing new;
    // this comes before the rate limit (lab-api.md), so such a repeat is 200 even when the limit for the challenge is reached.
    if (result === 'correct') {
      if (p.best === 3) return send(res, 200, { challenge_key: key, result, credit: 'credited' });
      if (a.integrity.some((f) => f.held && f.status === 'open' && f.challenge === key)) return send(res, 200, { challenge_key: key, result, credit: 'held' });
    }
    const recent = a.submissions.filter((s) => s.key === key && s.result === 'incorrect' && now - s.at < WINDOW_MS).sort((x, y) => x.at - y.at);
    if (recent.length >= WRONG_LIMIT) {
      const wait = Math.max(1, Math.ceil((recent[recent.length - WRONG_LIMIT].at + WINDOW_MS - now) / 1000));
      return problem(res, 429, 'ATT-FLAG-RATE-LIMITED', 'too many incorrect submissions for this challenge', undefined, { 'retry-after': String(wait) });
    }
    a.submissions.push({ key, result, at: now }); // every incorrect submission counts for the rate limit, whatever the reason
    if (reason !== 'correct') {
      reasonLog.push({ attempt_id: a.id, challenge_key: key, reason });
      process.stderr.write(JSON.stringify({ event: 'flag.reason', attempt_id: a.id, challenge_key: key, reason }) + '\n');
    }
    let credit = 'none';
    if (result === 'correct') {
      if (a.mode === 'candidate' && key === 'C11') {
        credit = 'held';
        p.held = true;
        a.integrity.push({ id: newId('g'), type: 'activity', challenge: key, explanation: 'The capture does not match the recorded activity; it is held for review.',
          status: 'open', held: true, createdAt: stamp(), decidedAt: null, note: null });
      } else {
        credit = 'credited';
        p.best = 3;
        addTimeline(a, { at: stamp(), type: 'milestone.reached', challenge_key: key, milestone: 'M3', result: null });
      }
    } else if (reason === 'decoy' || reason === 'other_instance') {
      a.integrity.push({ id: newId('g'), type: reason === 'decoy' ? 'decoy' : 'sharing', challenge: key,
        explanation: reason === 'decoy' ? 'A submitted value matched a decoy of this instance.' : 'A submitted value belongs to another instance.',
        status: 'open', held: false, createdAt: stamp(), decidedAt: null, note: null });
    }
    addTimeline(a, { at: stamp(), type: 'flag.submitted', challenge_key: key, milestone: null, result });
    send(res, 200, { challenge_key: key, result, credit });
  };
  H.getScore = ({ res, user, params, url }) => {
    const a = readable(res, user, params.attempt_id);
    if (a && queryOf(res, url, [])) send(res, 200, { attempt_id: a.id, score: total(a), computed_at: stamp(), per_challenge: scoreRows(a) });
  };
  H.listChallenges = ({ res, user, params, url }) => {
    const a = readable(res, user, params.attempt_id);
    if (!a || !queryOf(res, url, [])) return;
    send(res, 200, { items: KEYS.map((k) => { const p = a.progress.get(k);
      return { challenge_key: k, best_milestone: MILESTONES[p.best], solved: p.best === 3, held: p.held, hints_used: p.hints.size, hints_available: a.hintsEnabled }; }), has_more: false });
  };
  function hintContext(res, user, params) {
    const a = owned(res, user, params.attempt_id);
    if (!a) return null;
    if (!a.hintsEnabled) { problem(res, 404, 'ATT-HINTS-DISABLED', 'hints are off for this attempt'); return null; }
    if (!RE.challenge.test(params.challenge_key)) { problem(res, 404, 'ATT-CHALLENGE-NOT-FOUND', 'no such challenge'); return null; }
    return a;
  }
  const hintView = (a, key, level) => { const open = a.progress.get(key).hints.has(level);
    return { level, kind: HINT_KINDS[level - 1], unlocked: open, cost_pct: costPct(a, level), text: open ? hintText(key, level) : null }; };
  H.listHints = ({ res, user, params, url }) => {
    const o = findAttempt(res, params.attempt_id);
    if (!o || (o.ownerId !== user.id ? (attemptNotFound(res), true) : gone(res, o))) return; // ownership 404, then 410, then the hints-off 404
    const a = hintContext(res, user, params);
    if (a && queryOf(res, url, [])) send(res, 200, { challenge_key: params.challenge_key, items: [1, 2, 3].map((l) => hintView(a, params.challenge_key, l)), has_more: false });
  };
  H.unlockHint = ({ res, user, params, take }) => {
    const a = hintContext(res, user, params);
    if (!a || take() === false) return;
    if (!/^[1-3]$/.test(params.level)) return problem(res, 404, 'ATT-CHALLENGE-NOT-FOUND', 'no such hint level');
    if (a.state !== 'running') return problem(res, 409, 'ATT-INVALID-STATE', `a hint cannot be unlocked in state ${a.state}`);
    const level = Number(params.level);
    const set = a.progress.get(params.challenge_key).hints;
    if (!set.has(level)) {
      for (let lower = 1; lower < level; lower++) {
        if (!set.has(lower)) return problem(res, 409, 'ATT-INVALID-STATE', `hint level ${lower} must be unlocked first`, '/level');
      }
      set.add(level);
      addTimeline(a, { at: stamp(), type: 'hint.unlocked', challenge_key: params.challenge_key, milestone: null, result: null });
    }
    send(res, 200, hintView(a, params.challenge_key, level));
  };
  // A list that has a cap: `limit` (default 100, at most 100); has_more is true when entries were left out.
  function capped(res, url, all, view) {
    const q = queryOf(res, url, ['limit']);
    if (!q) return;
    const limit = parseLimit(res, q, 100, 100);
    if (limit === null) return;
    send(res, 200, { items: all.slice(0, limit).map(view), has_more: all.length > limit });
  }
  H.listEvidence = ({ res, user, params, url }) => { const a = reviewable(res, user, params.attempt_id); if (a) capped(res, url, a.evidence, (e) => e); };
  H.listIntegrityFlags = ({ res, user, params, url }) => { const a = reviewable(res, user, params.attempt_id); if (a) capped(res, url, flagsFor(user, a), flagView); };
  H.decideIntegrityFlag = ({ res, user, params, take }) => {
    const a = reviewable(res, user, params.attempt_id);
    if (!a) return;
    if (user.role !== 'recruiter') return attemptNotFound(res); // the owner may read but not decide (OI-38): same 404 as for anyone else
    const f = RE.flagId.test(params.integrity_flag_id) ? a.integrity.find((x) => x.id === params.integrity_flag_id) : undefined;
    if (!f) return attemptNotFound(res);
    const body = take();
    if (body === false || !checkKeys(res, body, ['decision', 'note'])) return;
    if (body.decision !== 'accept' && body.decision !== 'reject') return invalid(res, '/decision', 'decision is accept or reject');
    if (typeof body.note !== 'string' || body.note.length < 1 || body.note.length > 1000) return invalid(res, '/note', 'note is text of 1 to 1000 characters');
    if (f.status !== 'open') return problem(res, 409, 'ATT-INVALID-STATE', 'this flag already has a decision');
    f.status = body.decision === 'accept' ? 'accepted' : 'rejected';
    f.decidedAt = stamp();
    f.note = body.note;
    if (f.held && f.challenge) {
      const p = a.progress.get(f.challenge);
      p.held = a.integrity.some((x) => x !== f && x.held && x.status === 'open' && x.challenge === f.challenge); // held until no held flag is open
      if (body.decision === 'accept') p.best = 3;
    }
    send(res, 200, flagView(f));
  };
  H.getReport = ({ res, user, params, url }) => {
    const a = reviewable(res, user, params.attempt_id);
    if (!a || !queryOf(res, url, [])) return;
    const end = a.submittedAt ? Date.parse(a.submittedAt) : Date.now();
    const elapsed = a.startedAt ? Math.max(0, Math.round((end - Date.parse(a.startedAt)) / 1000)) : null;
    const rows = KEYS.map((k) => { const p = a.progress.get(k);
      return { challenge_key: k, best_milestone: MILESTONES[p.best], points: points(a, k), held: p.held, hints_used: p.hints.size,
        time_to_capture_seconds: null, technique_label: null }; });
    send(res, 200, { attempt_id: a.id, mode: a.mode, state: a.state, generated_at: stamp(), score: total(a), elapsed_seconds: elapsed, active_seconds: null,
      hints_used_total: rows.reduce((n, r) => n + r.hints_used, 0), integrity_open: flagsFor(user, a).filter((f) => f.status === 'open').length, per_challenge: rows });
  };
  // Cursor: base64url (no padding) of "f.<epoch>.<seq>", the key of the last entry already read; "f" is forward, the only direction. The mock
  // accepts only the canonical form it makes itself (whole numbers without sign, space, exponent, hex or leading zero, and no padding).
  const encodeCursor = (e) => Buffer.from(`f.${e.epoch}.${e.seq}`).toString('base64url');
  function decodeCursor(text) {
    if (!RE.cursor.test(text)) return null;
    const m = /^f\.([1-9][0-9]{0,8})\.([1-9][0-9]{0,15})$/.exec(Buffer.from(text, 'base64url').toString('utf8'));
    if (!m) return null;
    const key = { epoch: Number(m[1]), seq: Number(m[2]) };
    return Number.isSafeInteger(key.seq) && encodeCursor(key) === text ? key : null;
  }
  H.getTimeline = ({ res, user, params, url }) => {
    const a = readable(res, user, params.attempt_id);
    if (!a) return;
    const q = queryOf(res, url, ['cursor', 'limit']);
    if (!q) return;
    const limit = parseLimit(res, q, 50, 200);
    if (limit === null) return;
    let after = null;
    if (q.has('cursor')) {
      after = decodeCursor(q.get('cursor'));
      if (!after) return invalid(res, '/query/cursor', 'bad cursor');
    }
    // Sorted by the key (epoch, seq); a page holds the entries with a key above the cursor, so a late event with a smaller key is never in a later page.
    const sorted = [...a.timeline].sort((x, y) => x.epoch - y.epoch || x.seq - y.seq);
    const rest = after ? sorted.filter((e) => e.epoch > after.epoch || (e.epoch === after.epoch && e.seq > after.seq)) : sorted;
    const page = rest.slice(0, limit);
    const more = rest.length > limit;
    send(res, 200, { items: page.map(timelineView), has_more: more, next_cursor: more ? encodeCursor(page[page.length - 1]) : null });
  };

  // Test hook, not part of the contract: store a late event under the key it carries.
  async function lateEvent(res, buf) {
    let body;
    try { body = JSON.parse(buf.toString('utf8')); } catch { return invalid(res, '', 'the body is not valid JSON'); }
    if (!isObj(body)) return invalid(res, '', 'the body must be a JSON object');
    const a = typeof body.attempt_id === 'string' ? attempts.get(body.attempt_id) : undefined;
    if (!a) return attemptNotFound(res);
    const types = ['attempt.started', 'milestone.reached', 'flag.submitted', 'hint.unlocked', 'instance.reset', 'attempt.submitted', 'attempt.expired'];
    const type = body.type ?? 'flag.submitted';
    if (!Number.isSafeInteger(body.epoch) || body.epoch < 1) return invalid(res, '/epoch', 'epoch is a whole number of at least 1');
    if (!Number.isSafeInteger(body.seq) || body.seq < 1) return invalid(res, '/seq', 'seq is a whole number of at least 1');
    if (!types.includes(type)) return invalid(res, '/type', 'unknown timeline type');
    if (a.timeline.some((e) => e.epoch === body.epoch && e.seq === body.seq)) return problem(res, 409, 'ATT-INVALID-STATE', 'an event with this key exists');
    addTimeline(a, { at: stamp(), type, challenge_key: body.challenge_key ?? null, milestone: body.milestone ?? null, result: body.result ?? null }, { epoch: body.epoch, seq: body.seq });
    res.writeHead(204, { 'cache-control': 'private, no-store' });
    res.end();
  }

  // ---- routes: [method, regex, param names, handler, body mode] ----
  const ID = '([^/]+)';
  const ROUTES = [
    ['POST', /^\/api\/v1\/instances$/, [], 'requestInstance', 'json'],
    ['GET', new RegExp(`^/api/v1/instances/${ID}$`), ['instance_id'], 'getInstance'],
    ['POST', new RegExp(`^/api/v1/instances/${ID}/open$`), ['instance_id'], 'openInstance', 'none'],
    ['POST', new RegExp(`^/api/v1/instances/${ID}/reset$`), ['instance_id'], 'resetInstance', 'json'],
    ['POST', new RegExp(`^/api/v1/instances/${ID}/stop$`), ['instance_id'], 'stopInstance', 'none'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}$`), ['attempt_id'], 'getAttempt'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/start$`), ['attempt_id'], 'startAttempt', 'none'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/submit$`), ['attempt_id'], 'submitAttempt', 'json'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/withdraw$`), ['attempt_id'], 'withdrawAttempt', 'json'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/withdraw/undo$`), ['attempt_id'], 'undoWithdrawal', 'none'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/flags$`), ['attempt_id'], 'submitFlag', 'json'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/score$`), ['attempt_id'], 'getScore'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/challenges$`), ['attempt_id'], 'listChallenges'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/challenges/${ID}/hints$`), ['attempt_id', 'challenge_key'], 'listHints'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/challenges/${ID}/hints/${ID}/unlock$`), ['attempt_id', 'challenge_key', 'level'], 'unlockHint', 'none'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/evidence$`), ['attempt_id'], 'listEvidence'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/integrity-flags$`), ['attempt_id'], 'listIntegrityFlags'],
    ['POST', new RegExp(`^/api/v1/attempts/${ID}/integrity-flags/${ID}/decision$`), ['attempt_id', 'integrity_flag_id'], 'decideIntegrityFlag', 'json'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/report$`), ['attempt_id'], 'getReport'],
    ['GET', new RegExp(`^/api/v1/attempts/${ID}/timeline$`), ['attempt_id'], 'getTimeline'],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake.invalid');
    const method = req.method;
    const { buf, tooLarge } = await readBody(req, res);
    if (tooLarge) {
      res.setHeader('connection', 'close');
      return problem(res, 413, 'REQ-TOO-LARGE', `the body is larger than ${MAX_BODY} bytes`);
    }
    if (method === 'POST' && url.pathname === '/_fake/late-event') return lateEvent(res, buf);
    const onPath = ROUTES.filter((r) => r[1].test(url.pathname));
    if (onPath.length === 0) return problem(res, 404, 'REQ-ROUTE-UNKNOWN', 'no such route');
    const route = onPath.find((r) => r[0] === method);
    if (!route) {
      return problem(res, 405, 'REQ-METHOD-NOT-ALLOWED', `${method} is not allowed here`, undefined, { allow: onPath.map((r) => r[0]).join(', ') });
    }
    const token = cookies(req)[SESSION_COOKIE];
    const user = typeof token === 'string' && Object.hasOwn(USERS, token) ? USERS[token] : undefined;
    if (!user) return problem(res, 401, 'AUTH-SESSION-REQUIRED', 'sign in first');
    if (method === 'POST') {
      if (req.headers.origin !== cfg.origin) return problem(res, 403, 'AUTH-ORIGIN-FORBIDDEN', 'the Origin is not the dashboard origin');
      const csrf = req.headers['x-csrf-token'];
      const cookie = cookies(req)[CSRF_COOKIE];
      const csrfBuf = Buffer.from(csrf ?? ''), cookieBuf = Buffer.from(cookie ?? '');
      if (csrfBuf.length === 0 || csrfBuf.length !== cookieBuf.length || !crypto.timingSafeEqual(csrfBuf, cookieBuf)) {
        return problem(res, 403, 'AUTH-CSRF-FAILED', 'the CSRF header is missing or wrong');
      }
    }
    // Order of checks (lab-api.md section 3): the content type (415) comes before the lookup (404), so an id that does not exist is also 415 for a body that is not JSON.
    if (method === 'POST' && route[4] === 'json' && !/^application\/json(\s*;.*)?$/i.test(String(req.headers['content-type'] ?? ''))) {
      return problem(res, 415, 'REQ-UNSUPPORTED-MEDIA-TYPE', 'the body must be application/json');
    }
    const match = url.pathname.match(route[1]);
    let params;
    try { params = Object.fromEntries(route[2].map((n, i) => [n, decodeURIComponent(match[i + 1])])); } catch { return problem(res, 404, 'REQ-ROUTE-UNKNOWN', 'no such route'); }
    // Resource lookup and ownership (404) come before the body checks (415, 422), so an unknown id never shows a validation answer:
    // a handler calls take() only after its lookup. take() returns the parsed object, null when no body is allowed, or false after answering.
    const take = () => {
      if (method !== 'POST') return null;
      const parsed = parseBody(res, buf, route[4], req);
      return parsed.ok ? parsed.body : false;
    };
    return H[route[3]]({ res, user, params, take, url });
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`fake lab error: ${err.stack}\n`);
      if (!res.headersSent) problem(res, 500, 'REQ-INTERNAL', 'internal error');
    });
  });
  return {
    server, config: cfg, attempts, instances, reasonLog,
    // Rejects when the port is in use or cannot be used (the command line then exits 2 with a message).
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => {
      for (const r of instances.values()) clearTimeout(r.timer);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function parseArgs(argv) {
  const map = { '--port': 'port', '--host': 'host', '--origin': 'origin', '--step-delay-ms': 'stepDelayMs' };
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = map[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    if (name === 'port' || name === 'stepDelayMs') {
      if (name === 'port' && !/^[0-9]{1,5}$/.test(argv[i + 1])) throw new Error('--port must be a whole number from 0 to 65535');
      const n = Number(argv[i + 1]);
      if (argv[i + 1].trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${argv[i]} must be a finite number of 0 or more`);
      if (name === 'port' && (!Number.isInteger(n) || n > 65535)) throw new Error('--port must be a whole number from 0 to 65535');
      out[name] = n;
    } else out[name] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(err.message + '\n'); process.exit(2); }
  const svc = createFakeLab(opts);
  let port;
  try { port = await svc.listen(); } catch (err) { process.stderr.write(`cannot listen on ${opts.host ?? '127.0.0.1'}:${opts.port ?? 0}: ${err.code ?? err.message}\n`); process.exit(2); }
  process.stdout.write(JSON.stringify({ listening: true, port }) + '\n');
  const stop = () => svc.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
