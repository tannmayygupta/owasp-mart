// The lab console (apps/lab-console) run against a small fake DOM and a scripted API: what a learner sees must be what the lab says. No browser, no dependency.
// Covers the player experience of story L-30: the brief and the start text of every challenge, hints that stay on the page once revealed, the write-up after a capture,
// the progress steps, and the one-time link for Burp. Everything the server sends goes on the page as text, never as markup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'lab-console');
const APP =fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const HTML =fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.attrs = {}; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get childElementCount() { return this.children.length; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new El('#text'), { _text: n }) : n); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  select() { this.selected = true; }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, key: 'Enter', target: this }); }
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[data-(\w+)="([^"]*)"\])?$/.exec(sel);
    if (!m) throw new Error(`the fake DOM does not know the selector ${sel}`);
    if (m[1] && m[1] !== this.tagName) return false;
    const classes = String(this.className).split(/\s+/);
    for (const c of m[2].split('.').filter(Boolean)) if (!classes.includes(c)) return false;
    return !m[3] || this.dataset[m[3]] === m[4];
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches?.(sel)) return c; const f = c.querySelector?.(sel); if (f) return f; } return null; }
  all(sel) { const out = []; for (const c of this.children) { if (c.matches?.(sel)) out.push(c); out.push(...(c.all?.(sel) ?? [])); } return out; }
}

function boot(routes) {
  const byId = new Map();
  for (const m of HTML.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) byId.set(m[2], new El(m[1]));
  const calls = [];
  const copied = [];
  globalThis.document = { getElementById: (id) => byId.get(id) ?? (() => { throw new Error(`index.html has no #${id}`); })(), createElement: (tag) => new El(tag) };
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
    const body = typeof hit[1] === 'function' ? hit[1](opts) : hit[1];
    if (body?.__error) return { ok: false, status: body.__error, json: async () => ({ code: body.code }) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { byId, calls, copied, load: async () => { vm.runInThisContext(`(function(){${APP}\n})()`, { filename: 'app.js' }); } }; // a fresh run of app.js per test (the page runs it once per load)
}

const CATALOG = { items: [{ challenge_key: 'C01', title: 'Broken Access Control', owasp_2021: 'A01', owasp_2025: 'A01', tier: 'Easy' }, { challenge_key: 'C02', title: 'Cryptographic Failures', owasp_2021: 'A02', owasp_2025: 'A04', tier: 'Medium' }], has_more: false };
const PROGRESS = (extra = {}) => ({ items: [
  { challenge_key: 'C01', best_milestone: 'none', solved: false, held: false, hints_used: 1, hints_available: true, brief: 'Read a competitor order.', start: 'Sign in as staff.harbor@vulnmart.test with the password harbor-staff-demo-a1.' },
  { challenge_key: 'C02', best_milestone: 'M3', solved: true, held: false, hints_used: 0, hints_available: true, brief: 'Forge a gift card code.', start: 'Sign in as the customer.', write_up: { vulnerable: 'A weak hash of a serial.', fix: 'Random codes from a CSPRNG.' }, ...extra },
], has_more: false });
const ROUTES = (over = {}) => ({
  'GET /api/v1/session': { status: 'authenticated', user: { display_name: 'Ada' }, csrf_token: 'CSRF' },
  'GET /api/v1/challenges': CATALOG,
  'GET /api/v1/challenges/C01': { challenge_key: 'C01', cwe_primary: 'CWE-639' },
  'GET /api/v1/challenges/C02': { challenge_key: 'C02', cwe_primary: 'CWE-328' },
  'GET /api/v1/me/attempts': { items: [{ attempt_id: 'a-AAAAAAAAAAAAAAAA', state: 'running' }] },
  'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA': { attempt_id: 'a-AAAAAAAAAAAAAAAA', state: 'running', instance_id: 'i-BBBBBBBBBBBBBBBB', deadline_at: null },
  'GET /api/v1/instances/i-BBBBBBBBBBBBBBBB': { instance_id: 'i-BBBBBBBBBBBBBBBB', state: 'ready', access: 'open', epoch: 1 },
  'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/score': { score: 94, per_challenge: [{ challenge_key: 'C01', points: 0 }, { challenge_key: 'C02', points: 94 }] },
  'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges': PROGRESS(),
  'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/timeline?limit=50': { items: [] },
  'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges/C01/hints': { items: [{ level: 1, kind: 'nudge', unlocked: true, cost_pct: 0, text: 'Look at how one order is identified.' }, { level: 2, kind: 'direction', unlocked: false, cost_pct: 0, text: null }, { level: 3, kind: 'near_solution', unlocked: false, cost_pct: 0, text: null }] },
  'POST /api/v1/instances/i-BBBBBBBBBBBBBBBB/open': { url: 'https://i-bbbbbbbbbbbbbbbb.labs.example/_vm/enter?t=ticket', expires_at: '2026-10-20T10:00:00Z' },
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 30));

test('every challenge shows what it is, how to begin and its tags; a captured one shows the write-up and a locked flag box', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  const rows = app.byId.get('rows');
  const [c01, c02] = rows.all('details');
  assert.equal(rows.all('details').length, 2);
  assert.equal(c01.dataset.key, 'C01');
  assert.equal(c01.querySelector('.title').textContent, 'Broken Access Control');
  assert.equal(c01.querySelector('.tier').textContent, 'Easy');
  assert.match(c01.textContent, /Read a competitor order\./);
  assert.match(c01.querySelector('.box').textContent, /How to begin.*staff\.harbor@vulnmart\.test.*harbor-staff-demo-a1/);
  assert.match(c01.textContent, /OWASP 2021 A01/);
  assert.equal(c01.querySelector('.prog').textContent, 'not yet');
  assert.equal(c02.querySelector('.prog').textContent, 'captured');
  assert.match(c02.textContent, /Captured\. What was wrong.*A weak hash of a serial\./);
  assert.match(c02.textContent, /How to fix it.*Random codes from a CSPRNG\./);
  assert.equal(c02.querySelector('input.flag').disabled, true, 'a captured challenge takes no more flags');
  assert.equal(c01.querySelector('input.flag').disabled, false);
  assert.equal(app.byId.get('score').textContent, '94');
  assert.equal(app.byId.get('captured').textContent, '1 of 2 challenges captured');
  assert.equal(app.byId.get('bar-fill').style.width, '9%');
});

test('opening a challenge loads its hints: the revealed one stays on the page, the next can be revealed, the later one is locked', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  const c01 = app.byId.get('rows').querySelector('details[data-key="C01"]');
  c01.open = true;
  await c01.fire('toggle'); await settle();
  assert.ok(app.calls.includes('GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges/C01/hints'));
  assert.ok(app.calls.includes('GET /api/v1/challenges/C01'), 'the CWE of the challenge is fetched when it is opened');
  const body = c01.querySelector('.ch-body');
  assert.match(body.textContent, /Hint 1: A nudge.*Look at how one order is identified\./);
  assert.match(body.textContent, /CWE-639/);
  const buttons = body.all('button').map((b) => [b.textContent, b.disabled]);
  assert.deepEqual(buttons, [['Reveal', false], ['Locked', true], ['Check', false]], 'hint 2 can be revealed, hint 3 is locked, then the flag check');
});

test('a hint that cannot be revealed says why on its own row, and the hint stays locked', async () => {
  const app = boot(ROUTES({ 'POST /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges/C01/hints/2/unlock': { __error: 409, code: 'ATT-INVALID-STATE' } }));
  await app.load(); await settle();
  const c01 = app.byId.get('rows').querySelector('details[data-key="C01"]');
  c01.open = true; await c01.fire('toggle'); await settle();
  const reveal = c01.querySelector('.ch-body').all('button')[0];
  assert.equal(reveal.textContent, 'Reveal');
  await reveal.fire('click'); await settle();
  const row2 = c01.querySelector('.ch-body').all('.hintrow')[1];
  assert.match(row2.textContent, /Hint 2: A direction.*cannot be done in the attempt's state now/, 'the error is on the hint row');
  assert.doesNotMatch(row2.textContent, /Look at how/, 'no hint text appears');
});

test('a revealed hint is on the page even when the follow-up progress call fails', async () => {
  let progressCalls = 0;
  const app = boot(ROUTES({
    'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges': () => (++progressCalls <= 2 ? PROGRESS() : { __error: 500, code: 'REQ-INTERNAL' }),
    'POST /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges/C01/hints/2/unlock': { level: 2, kind: 'direction', unlocked: true, cost_pct: 0, text: 'Order numbers run in sequence.' },
  }));
  await app.load(); await settle();
  const c01 = app.byId.get('rows').querySelector('details[data-key="C01"]');
  c01.open = true; await c01.fire('toggle'); await settle();
  const before = progressCalls;
  await c01.querySelector('.ch-body').all('button')[0].fire('click'); await settle();
  assert.ok(progressCalls > before, 'the refresh did run and failed');
  const body = c01.querySelector('.ch-body');
  assert.match(body.textContent, /Hint 2: A direction.*Order numbers run in sequence\./);
  assert.deepEqual(body.all('button').map((b) => [b.textContent, b.disabled]), [['Reveal', false], ['Check', false]], 'hint 3 is next');
});

test('the Open area tells the learner to open DevTools in the shop tab and to keep the log', () => {
  assert.match(HTML, /id="devtools-note"[^>]*>[^<]*F12 in that tab[^<]*Network[^<]*Preserve log/);
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

test('the four steps follow what the lab knows: started, opened, a milestone, a capture', async () => {
  const app = boot(ROUTES());
  await app.load(); await settle();
  const classes = () => [1, 2, 3, 4].map((n) => app.byId.get(`step-${n}`).className);
  assert.deepEqual(classes(), ['done', 'done', 'done', 'done'], 'C02 is captured in this session');
  const fresh = boot(ROUTES({ 'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges': { items: PROGRESS().items.slice(0, 1), has_more: false } }));
  await fresh.load(); await settle();
  assert.deepEqual([1, 2, 3, 4].map((n) => fresh.byId.get(`step-${n}`).className), ['done', 'now', '', ''], 'started, shop not opened yet');
});

test('what the server sends goes on the page as text: markup in a brief is not markup', async () => {
  const evil = PROGRESS();
  evil.items[0].brief = '<img src=x onerror=alert(1)>';
  const app = boot(ROUTES({ 'GET /api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges': evil }));
  await app.load(); await settle();
  const c01 = app.byId.get('rows').querySelector('details[data-key="C01"]');
  assert.match(c01.textContent, /<img src=x onerror=alert\(1\)>/, 'shown as the characters it is');
  assert.equal(c01.all('img').length, 0);
});