// The lab console (apps/lab-console) run against a small fake DOM and a scripted API: what a learner sees must be what the lab says. No browser, no dependency.
// It covers the sandbox flow of backlog story 11: one challenge at a time, the countdown by difficulty that starts at Begin, hints that stay on the page once revealed,
// the result and the way on after a capture, the points of the account, a new run after a finished one, and the one-time link for Burp.
// Everything the server sends goes on the page as text, never as markup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'lab-console');
const APP = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.attrs = {}; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get childElementCount() { return this.children.filter((c) => c.tagName !== '#TEXT').length; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new El('#text'), { _text: n }) : n); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  select() { this.selected = true; }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, key: 'Enter', target: this }); }
  all(test) { const out = []; for (const c of this.children) { if (test(c)) out.push(c); out.push(...c.all(test)); } return out; }
  buttons() { return this.all((n) => n.tagName === 'BUTTON'); }
  button(label) { return this.buttons().find((b) => b.textContent.startsWith(label)); }
  withClass(cls) { return this.all((n) => String(n.className).split(/\s+/).includes(cls)); }
}

function boot(routes) {
  const byId = new Map();
  for (const m of HTML.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) byId.set(m[2], new El(m[1]));
  const calls = [];
  const copied = [];
  globalThis.document = { getElementById: (id) => byId.get(id) ?? (() => { throw new Error(`index.html has no #${id}`); })(), createElement: (tag) => new El(tag), createElementNS: (_ns, tag) => new El(tag) };
  globalThis.location = { pathname: '/', search: '' };
  globalThis.history = { replaceState() {} };
  globalThis.window = { open: () => null };
  globalThis.confirm = () => true;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    calls.push(key);
    const hit = Object.entries(routes).find(([k]) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
    if (!hit) return { ok: false, status: 404, json: async () => ({ code: 'ATT-NOT-FOUND' }) };
    const body = typeof hit[1] === 'function' ? await hit[1](opts) : hit[1]; // a route may answer late (a promise)
    if (body?.__error) return { ok: false, status: body.__error, json: async () => ({ code: body.code }) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { byId, calls, copied, mission: () => byId.get('mission'), load: async () => { vm.runInThisContext(`(function(){${APP}\n})()`, { filename: 'app.js' }); } }; // a fresh run of app.js per test (the page runs it once per load)
}

const A = 'a-AAAAAAAAAAAAAAAA';
const CATALOG = { items: [
  { challenge_key: 'C01', title: 'Broken Access Control', owasp_2021: 'A01', owasp_2025: 'A01', tier: 'Easy' },
  { challenge_key: 'C02', title: 'Cryptographic Failures', owasp_2021: 'A02', owasp_2025: 'A04', tier: 'Medium' },
], has_more: false };
const far = (s) => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const ITEM = (extra = {}) => ({ challenge_key: 'C01', best_milestone: 'none', solved: false, held: false, hints_used: 0, hints_available: true, title: 'Broken Access Control', tier: 'Easy',
  time_limit_seconds: 1200, brief: 'Read a competitor order.', state: 'ready', opened_at: null, expires_at: null, seconds_left: 1200, ...extra });
const LIST = (items, current = 'C01') => ({ items, has_more: false, total: 2, current_key: current, server_time: far(0) });
const ROUTES = (over = {}) => ({
  'GET /api/v1/session': { status: 'authenticated', user: { display_name: 'Ada' }, csrf_token: 'CSRF' },
  'GET /api/v1/challenges': CATALOG,
  'GET /api/v1/me/attempts': { items: [{ attempt_id: A, mode: 'learner', state: 'running' }] },
  [`GET /api/v1/attempts/${A}`]: { attempt_id: A, mode: 'learner', state: 'running', instance_id: 'i-BBBBBBBBBBBBBBBB', deadline_at: far(3600) },
  'GET /api/v1/instances/i-BBBBBBBBBBBBBBBB': { instance_id: 'i-BBBBBBBBBBBBBBBB', state: 'ready', access: 'open', epoch: 1 },
  [`GET /api/v1/attempts/${A}/score`]: { score: 0, per_challenge: [{ challenge_key: 'C01', points: 0 }, { challenge_key: 'C02', points: 0 }] },
  [`GET /api/v1/attempts/${A}/challenges`]: LIST([ITEM()]),
  [`GET /api/v1/attempts/${A}/timeline?limit=50`]: { items: [] },
  'GET /api/v1/me/progress': { total_points: 140, runs: 2, per_challenge: [{ challenge_key: 'C01', best_points: 140 }] },
  [`POST /api/v1/attempts/${A}/challenges/C01/begin`]: ITEM({ state: 'active' }),
  'POST /api/v1/instances/i-BBBBBBBBBBBBBBBB/open': { url: 'https://i-bbbbbbbbbbbbbbbb.labs.example/_vm/enter?t=ticket', expires_at: '2026-10-20T10:00:00Z' },
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 30));

test('the learner sees ONE challenge: its title, tier, brief, the minutes it will get, and a Begin button; the account points show in the top bar', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  const m = app.mission();
  assert.match(m.textContent, /Challenge 1 of 2/);
  assert.match(m.textContent, /Broken Access Control/);
  assert.match(m.textContent, /Easy/);
  assert.match(m.textContent, /Read a competitor order\./);
  assert.match(m.textContent, /You will have 20 minutes once you begin/);
  assert.ok(m.button('Begin challenge (20 min)'), 'the primary action');
  assert.doesNotMatch(m.textContent, /Cryptographic Failures/, 'the other challenges are not shown');
  assert.equal(m.withClass('flag-input').length, 0, 'no flag box before the countdown runs');
  assert.equal(app.byId.get('acct-num').textContent, '140');
  assert.equal(app.byId.get('rail').children.length, 2, 'the rail shows every challenge as a dot');
});

test('Begin starts the countdown of that challenge: a call to the begin route, then the hints and the flag box appear', async () => {
  let begun = false;
  const app = boot(ROUTES({
    [`GET /api/v1/attempts/${A}/challenges`]: () => LIST([ITEM(begun ? { state: 'active', opened_at: far(-5), expires_at: far(1195), seconds_left: 1195, start: 'Sign in as the demo customer.' } : {})]),
    [`POST /api/v1/attempts/${A}/challenges/C01/begin`]: () => { begun = true; return ITEM({ state: 'active' }); },
    [`GET /api/v1/attempts/${A}/challenges/C01/hints`]: { items: [{ level: 1, kind: 'nudge', unlocked: false, cost_pct: 0, text: null }, { level: 2, kind: 'direction', unlocked: false, cost_pct: 0, text: null }, { level: 3, kind: 'near_solution', unlocked: false, cost_pct: 0, text: null }] },
  }));
  await app.load(); await settle();
  await app.mission().button('Begin challenge').fire('click'); await settle();
  assert.ok(app.calls.includes(`POST /api/v1/attempts/${A}/challenges/C01/begin`));
  const m = app.mission();
  assert.match(m.textContent, /How to begin.*Sign in as the demo customer\./);
  assert.ok(m.button('Open the shop in a new tab'));
  assert.equal(m.withClass('flag-input').length, 1);
  assert.match(m.textContent, /1[89]:\d\d/, 'a countdown of nearly twenty minutes');
  assert.deepEqual(m.buttons().filter((b) => /Reveal|Locked/.test(b.textContent)).map((b) => [b.textContent, b.disabled]), [['Reveal', false], ['Locked', true], ['Locked', true]]);
});

test('a revealed hint stays on the page; one that cannot be revealed says why on its own row', async () => {
  const active = ITEM({ state: 'active', start: 'Sign in.', expires_at: far(1100), seconds_left: 1100 });
  const hints = (unlocked) => ({ items: [{ level: 1, kind: 'nudge', unlocked, cost_pct: 0, text: unlocked ? 'Look at how one order is identified.' : null }, { level: 2, kind: 'direction', unlocked: false, cost_pct: 0, text: null }, { level: 3, kind: 'near_solution', unlocked: false, cost_pct: 0, text: null }] });
  let revealed = false;
  const app = boot(ROUTES({
    [`GET /api/v1/attempts/${A}/challenges`]: () => LIST([{ ...active, hints_used: revealed ? 1 : 0 }]),
    [`GET /api/v1/attempts/${A}/challenges/C01/hints`]: () => hints(revealed),
    [`POST /api/v1/attempts/${A}/challenges/C01/hints/1/unlock`]: () => { revealed = true; return hints(true).items[0]; },
    [`POST /api/v1/attempts/${A}/challenges/C01/hints/2/unlock`]: { __error: 409, code: 'ATT-INVALID-STATE' },
  }));
  await app.load(); await settle();
  await app.mission().button('Reveal').fire('click'); await settle();
  assert.match(app.mission().textContent, /Hint 1: A nudge.*Look at how one order is identified\./);
  assert.equal(app.mission().buttons().find((b) => b.textContent === 'Reveal').disabled, false, 'hint 2 is next');
  await app.mission().button('Reveal').fire('click'); await settle();
  const rows = app.mission().withClass('hint');
  assert.match(rows[1].textContent, /Hint 2: A direction.*cannot be done right now/, 'the error is on the hint row');
  assert.match(rows[0].textContent, /Look at how/, 'the first hint is still there');
});

test('a correct flag shows the result, the points and the write-up, and offers the next challenge; a wrong one says so and stays', async () => {
  const active = ITEM({ state: 'active', start: 'Sign in.', expires_at: far(1100), seconds_left: 1100 });
  const solved = ITEM({ state: 'solved', solved: true, best_milestone: 'M3', write_up: { vulnerable: 'The order id was guessable.', fix: 'Check the owner of the order.' } });
  let captured = false; let sentFlag = '';
  const app = boot(ROUTES({
    [`GET /api/v1/attempts/${A}/challenges`]: () => (captured ? LIST([solved, ITEM({ challenge_key: 'C02', title: 'Cryptographic Failures', tier: 'Medium', time_limit_seconds: 2400, seconds_left: 2400 })], 'C02') : LIST([active])),
    [`GET /api/v1/attempts/${A}/score`]: () => ({ score: captured ? 94 : 0, per_challenge: [{ challenge_key: 'C01', points: captured ? 94 : 0 }, { challenge_key: 'C02', points: 0 }] }),
    [`GET /api/v1/attempts/${A}/challenges/C01/hints`]: { items: [] },
    [`POST /api/v1/attempts/${A}/flags`]: (o) => { sentFlag = JSON.parse(o.body).flag; captured = sentFlag === 'VM{right}'; return { challenge_key: 'C01', result: captured ? 'correct' : 'incorrect', credit: captured ? 'full' : null }; },
  }));
  await app.load(); await settle();
  let input = app.mission().withClass('flag-input')[0];
  input.value = 'VM{wrong}'; await app.mission().button('Check flag').fire('click'); await settle();
  assert.match(app.mission().textContent, /That is not the flag for C01\./);
  assert.equal(app.mission().withClass('flag-input').length, 1, 'a wrong flag keeps the learner on the challenge');
  input = app.mission().withClass('flag-input')[0];
  input.value = 'VM{right}'; await app.mission().button('Check flag').fire('click'); await settle();
  const m = app.mission();
  assert.match(m.textContent, /Flag captured/);
  assert.match(m.textContent, /94 pts/);
  assert.match(m.textContent, /What was wrong.*The order id was guessable\./);
  assert.match(m.textContent, /How to fix it.*Check the owner of the order\./);
  assert.equal(m.withClass('flag-input').length, 0);
  await m.button('Next challenge').fire('click');
  assert.match(app.mission().textContent, /Challenge 2 of 2.*Cryptographic Failures/);
  assert.ok(app.mission().button('Begin challenge (40 min)'), 'a Medium challenge gets 40 minutes');
  assert.equal(app.byId.get('score').textContent, '94');
});

test('when the time is over the challenge says so, shows the write-up, and no flag can be pasted', async () => {
  const gone = ITEM({ state: 'expired', seconds_left: 0, expires_at: far(-10), write_up: { vulnerable: 'It was guessable.', fix: 'Check the owner.' } });
  const app = boot(ROUTES({ [`GET /api/v1/attempts/${A}/challenges`]: LIST([gone, ITEM({ challenge_key: 'C02', title: 'Cryptographic Failures', tier: 'Medium', seconds_left: 2400, time_limit_seconds: 2400 })], 'C02') }));
  await app.load(); await settle();
  await app.byId.get('rail').children[0].children[0].fire('click'); // look back at the first one
  const m = app.mission();
  assert.match(m.textContent, /The time for this challenge is over/);
  assert.match(m.textContent, /How to fix it/);
  assert.equal(m.withClass('flag-input').length, 0);
});

test('with no run the learner is offered one primary action; after a finished run the points are kept and a new run is offered', async () => {
  const none = boot(ROUTES({ 'GET /api/v1/me/attempts': { items: [] } }));
  await none.load(); await settle();
  assert.ok(none.mission().button('Start my lab'));
  await none.mission().button('Start my lab').fire('click'); await settle();
  assert.ok(none.calls.includes('POST /api/v1/instances'));

  const done = boot(ROUTES({
    'GET /api/v1/me/attempts': { items: [{ attempt_id: A, mode: 'learner', state: 'submitted' }] },
    [`GET /api/v1/attempts/${A}`]: { attempt_id: A, mode: 'learner', state: 'submitted', instance_id: null, deadline_at: null },
    [`GET /api/v1/attempts/${A}/score`]: { score: 94, per_challenge: [{ challenge_key: 'C01', points: 94 }, { challenge_key: 'C02', points: 0 }] },
    [`GET /api/v1/attempts/${A}/challenges`]: LIST([ITEM({ state: 'solved', solved: true }), ITEM({ challenge_key: 'C02', title: 'Cryptographic Failures', state: 'expired' })]),
  }));
  await done.load(); await settle();
  assert.match(done.mission().textContent, /This run is finished/);
  assert.match(done.mission().textContent, /You scored 94 of 1000/);
  assert.match(done.mission().textContent, /best result for each challenge/);
  assert.ok(done.mission().button('Start a new run'));
  assert.equal(done.byId.get('acct-num').textContent, '140');
});

test('a lab that is not sequenced still works: every challenge is open, no countdown, the first one not captured is shown', async () => {
  const plain = { items: [
    { challenge_key: 'C01', best_milestone: 'M3', solved: true, held: false, hints_used: 0, hints_available: true },
    { challenge_key: 'C02', best_milestone: 'none', solved: false, held: false, hints_used: 0, hints_available: true, brief: 'Forge a gift card code.' },
  ], has_more: false };
  const app = boot(ROUTES({ [`GET /api/v1/attempts/${A}/challenges`]: plain, 'GET /api/v1/me/progress': { __error: 404, code: 'REQ-ROUTE-UNKNOWN' }, [`GET /api/v1/attempts/${A}/challenges/C02/hints`]: { items: [] } }));
  await app.load(); await settle();
  const m = app.mission();
  assert.match(m.textContent, /Cryptographic Failures/);
  assert.match(m.textContent, /Forge a gift card code\./);
  assert.equal(m.withClass('flag-input').length, 1);
  assert.equal(app.byId.get('acct-num').textContent, '0');
});

test('everything from the server goes on the page as text, never as markup', () => {
  assert.doesNotMatch(APP, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(HTML, /<script(?![^>]*\bsrc=)/, 'no inline script');
  assert.doesNotMatch(HTML, /\sstyle=/, 'no inline style');
});

test('the Open area tells the learner to open DevTools in the shop tab and to keep the log', () => {
  assert.match(HTML, /id="devtools-note"[^>]*>[^<]*F12 in that tab[\s\S]*?Network[\s\S]*?Preserve log/);
});

test('Copy link for Burp asks for a fresh ticket, shows it, copies it and never opens a window', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  await app.byId.get('copy').fire('click'); await settle();
  assert.equal(app.byId.get('link').value, 'https://i-bbbbbbbbbbbbbbbb.labs.example/_vm/enter?t=ticket');
  assert.equal(app.byId.get('link-box').hidden, false);
  assert.deepEqual(app.copied, ['https://i-bbbbbbbbbbbbbbbb.labs.example/_vm/enter?t=ticket']);
  assert.equal(app.calls.filter((c) => c.startsWith('POST /api/v1/instances/')).length, 1);
  assert.match(app.byId.get('banner').textContent, /Link copied/);
});

const CAND = 'a-CCCCCCCCCCCCCCCC';

test('a company assessment is never picked as the practice run, even when it is the only live attempt', async () => {
  const app = boot(ROUTES({
    'GET /api/v1/me/attempts': { items: [{ attempt_id: CAND, mode: 'candidate', state: 'running' }] },
    [`GET /api/v1/attempts/${CAND}`]: { attempt_id: CAND, mode: 'candidate', state: 'running', instance_id: 'i-DDDDDDDDDDDDDDDD', deadline_at: far(3600) },
  }));
  await app.load(); await settle();
  assert.ok(!app.calls.includes(`GET /api/v1/attempts/${CAND}`), 'the candidate attempt is not even read');
  assert.ok(!app.calls.some((c) => c.includes(`/attempts/${CAND}/`)), 'nothing of it is loaded');
  const m = app.mission();
  assert.match(m.textContent, /Start my lab/);
  assert.match(m.textContent, /company assessment/);
  const link = m.all((n) => n.tagName === 'A')[0];
  assert.equal(link.href, `/assessment/${CAND}`, 'the note links to the assessment page');
  assert.equal(m.withClass('flag-input').length, 0);
});

test('with a practice run and an assessment, the practice run is shown and the assessment is left alone', async () => {
  const app = boot(ROUTES({
    'GET /api/v1/me/attempts': { items: [{ attempt_id: CAND, mode: 'candidate', state: 'running' }, { attempt_id: A, mode: 'learner', state: 'running' }] },
  }));
  await app.load(); await settle();
  assert.match(app.mission().textContent, /Broken Access Control/);
  assert.ok(!app.calls.some((c) => c.includes(CAND)));
  assert.doesNotMatch(app.mission().textContent, /company assessment/, 'no note while a practice run exists');
});

test('an attempt whose own answer says candidate is dropped even if the list said learner', async () => {
  const app = boot(ROUTES({ [`GET /api/v1/attempts/${A}`]: { attempt_id: A, mode: 'candidate', state: 'running', instance_id: null, deadline_at: far(60) } }));
  await app.load(); await settle();
  assert.match(app.mission().textContent, /Start my lab/);
  assert.equal(app.mission().withClass('flag-input').length, 0);
});
// ---- the landing page and the way the console feels (the pointer, the reasons, the rail) ----

test('signed out, the page is the landing page: what the platform offers and two buttons, and no form of its own', async () => {
  const app = boot(ROUTES({ 'GET /api/v1/session': { status: 'anonymous' } }));
  await app.load(); await settle();
  assert.equal(app.byId.get('landing').hidden, false);
  assert.equal(app.byId.get('lab').hidden, true);
  assert.equal(app.byId.get('guest').hidden, false, 'Sign in and Create account sit in the top bar');
  assert.equal(app.byId.get('who').hidden, true);
  assert.doesNotMatch(HTML, /id="login-form"|id="signup-form"|id="auth"/, 'sign in and sign up are the pages /login and /signup, not a second form here');
  assert.match(HTML, /href="\/signup"/); assert.match(HTML, /href="\/login"/);
  assert.match(HTML, /mailto:/, 'the footer carries a contact');
  assert.ok(!app.calls.some((c) => c.startsWith('GET /api/v1/challenges')), 'nothing of the lab is asked for while signed out');
});

test('a recruiter or an administrator who opens / is sent to the dashboards, a learner gets the lab', async () => {
  for (const kind of ['recruiter', 'admin']) {
    const app = boot(ROUTES({ 'GET /api/v1/session': { status: 'authenticated', user: { display_name: 'R', account_type: kind }, csrf_token: 'C' } }));
    let went = null; globalThis.location.replace = (to) => { went = to; };
    await app.load(); await settle();
    assert.equal(went, '/dashboard', kind);
    assert.ok(!app.calls.some((c) => c.startsWith('GET /api/v1/challenges')), 'no lab is loaded for them');
  }
  const learner = boot(ROUTES({ 'GET /api/v1/session': { status: 'authenticated', user: { display_name: 'L', account_type: 'participant' }, csrf_token: 'C' } }));
  await learner.load(); await settle();
  assert.equal(learner.byId.get('lab').hidden, false);
});

test('a locked challenge on the rail answers a click and says why; an open one says its name and opens', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  const dots = app.byId.get('rail').buttons();
  assert.equal(dots.length, 2);
  assert.match(dots[0].title, /Challenge 1: Broken Access Control/);
  assert.equal(dots[0].attrs['aria-disabled'], undefined, 'an open challenge is a normal button');
  assert.match(dots[1].className, /locked/);
  assert.equal(dots[1].attrs['aria-disabled'], 'true');
  assert.equal(dots[1].disabled, false, 'it stays focusable, so a keyboard user hears the reason too');
  await dots[1].fire('click');
  assert.match(app.byId.get('banner').textContent, /Challenge 2 is locked\. Capture challenge 1/);
  assert.equal(app.byId.get('banner').className, 'info');
});

test('with the shop down, picking a challenge on the rail shows that challenge and its brief, not an unchanged page', async () => {
  const app = boot(ROUTES({ 'GET /api/v1/instances/i-BBBBBBBBBBBBBBBB': { instance_id: 'i-BBBBBBBBBBBBBBBB', state: 'destroyed', access: 'closed', epoch: 1 } }));
  await app.load(); await settle();
  assert.match(app.mission().textContent, /Your shop is not running/);
  assert.match(app.mission().textContent, /Challenge 1: Broken Access Control \(Easy\)/);
  assert.match(app.mission().textContent, /Read a competitor order\./);
  assert.ok(app.mission().button('Build a new shop'));
});

test('a button that cannot be pressed says why, and the "Building your shop" message goes away once the shop is up', async () => {
  const down = boot(ROUTES({ 'GET /api/v1/instances/i-BBBBBBBBBBBBBBBB': { instance_id: 'i-BBBBBBBBBBBBBBBB', state: 'destroyed', access: 'closed', epoch: 1 } }));
  await down.load(); await settle();
  assert.equal(down.byId.get('open').disabled, true);
  assert.match(down.byId.get('open').title, /when your shop is running/);
  assert.match(down.byId.get('stop').title, /no running shop/);
  const up = boot(ROUTES());
  await up.load(); await settle();
  up.byId.get('banner').textContent = 'Building your shop. This takes a few seconds.'; up.byId.get('banner').hidden = false;
  await up.byId.get('open').fire('click'); await settle();
  assert.equal(up.byId.get('open').disabled, false);
  assert.equal(up.byId.get('open').title, '', 'an enabled button keeps its own title');
});

test('the styles make clickable things look clickable and the locked ones look locked', () => {
  const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
  assert.match(css, /button, summary[^{]*\{\s*cursor:pointer/);
  assert.match(css, /button:disabled[^{]*\{\s*cursor:not-allowed/);
  assert.match(css, /\.dot\.locked/);
  assert.match(css, /#banner\.info/);
});

test('Start pressed while a read of the old run is still in flight still shows the new run (the request is not dropped)', async () => {
  let started = false;
  const FINISHED_ATTEMPT = { attempt_id: A, mode: 'learner', state: 'submitted' };
  const NEW = 'a-NNNNNNNNNNNNNNNN';
  const app = boot(ROUTES({
    // the list of attempts answers late and, if asked before the start, with the old finished run only
    'GET /api/v1/me/attempts': async () => { const before = !started; await new Promise((r) => setTimeout(r, 120)); return { items: before ? [FINISHED_ATTEMPT] : [{ attempt_id: NEW, mode: 'learner', state: 'running' }, FINISHED_ATTEMPT] }; },
    [`GET /api/v1/attempts/${A}`]: { attempt_id: A, mode: 'learner', state: 'submitted', instance_id: null, deadline_at: null },
    [`GET /api/v1/attempts/${A}/challenges`]: LIST([ITEM({ state: 'solved', solved: true })]),
    [`GET /api/v1/attempts/${NEW}`]: { attempt_id: NEW, mode: 'learner', state: 'running', instance_id: 'i-BBBBBBBBBBBBBBBB', deadline_at: far(3600) },
    [`GET /api/v1/attempts/${NEW}/challenges`]: LIST([ITEM()]),
    [`GET /api/v1/attempts/${NEW}/score`]: { score: 0, per_challenge: [{ challenge_key: 'C01', points: 0 }] },
    [`GET /api/v1/attempts/${NEW}/timeline?limit=50`]: { items: [] },
    'POST /api/v1/instances': () => { started = true; return { attempt_id: NEW, instance_id: 'i-BBBBBBBBBBBBBBBB' }; },
  }));
  await app.load();
  await new Promise((r) => setTimeout(r, 40)); // the first read is still in flight (it takes 120 ms)
  // the page already offers a Start button (the first answer is still on its way); press it
  await app.mission().button('Start my lab').fire('click');
  await new Promise((r) => setTimeout(r, 600));
  assert.match(app.mission().textContent, /Challenge 1 of 2|Begin challenge/, 'the new run is shown, not the finished one');
  assert.doesNotMatch(app.mission().textContent, /This run is finished/);
});

test('a challenge that the lab credits by itself while it is on screen stays on screen as captured, so the flag just found is not pasted into the next challenge', async () => {
  let captured = false;
  const items = () => (captured
    ? [ITEM({ state: 'solved', solved: true, best_milestone: 'M3', write_up: { vulnerable: 'No store check.', fix: 'Scope the lookup.' } }), ITEM({ challenge_key: 'C02', title: 'Cryptographic Failures', tier: 'Medium', state: 'ready', brief: 'Forge a code.' })]
    : [ITEM({ state: 'active', expires_at: far(1100), seconds_left: 1100 })]);
  const app = boot(ROUTES({
    [`GET /api/v1/attempts/${A}/challenges`]: () => LIST(items(), captured ? 'C02' : 'C01'),
    [`GET /api/v1/attempts/${A}/challenges/C01/hints`]: { items: [] },
    [`POST /api/v1/attempts/${A}/flags`]: () => ({ result: 'incorrect' }),
  }));
  await app.load(); await settle();
  assert.match(app.mission().textContent, /Broken Access Control/);
  assert.equal(app.mission().withClass('flag-input').length, 1, 'C01 is active with its flag box');
  captured = true; // the sidecar saw the flag in a response and the platform credited it; the page's next read (here caused by a paste) says so
  app.mission().withClass('flag-input')[0].value = 'VM{NOT-THE-FLAG}';
  await app.mission().button('Check flag').fire('click'); await settle();
  assert.match(app.mission().textContent, /Flag captured/, 'the captured challenge stays on screen');
  assert.match(app.mission().textContent, /do not have to paste it/);
  assert.ok(app.mission().button('Next challenge'), 'and the way on is one button');
  assert.match(app.byId.get('banner').textContent, /C01 captured: the lab saw the flag/);
  assert.doesNotMatch(app.mission().textContent, /Cryptographic Failures/, 'the next challenge is not shown until the learner moves on');
});
