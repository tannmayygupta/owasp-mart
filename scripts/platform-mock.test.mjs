import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';
import { DEFAULT_BUNDLE, DEFAULT_ERRORS, DEFAULT_ORIGIN, createMock, main, startFakeLab } from '../contracts/mocks/platform-mock/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'contracts', 'api', 'platform', 'examples');
const bundle = JSON.parse(fs.readFileSync(DEFAULT_BUNDLE, 'utf8'));
const errors = yaml.load(fs.readFileSync(DEFAULT_ERRORS, 'utf8'));
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const ops = Object.entries(bundle.paths).flatMap(([p, item]) => METHODS.filter((m) => item[m]).map((m) => ({ path: p, method: m.toUpperCase(), op: item[m] })));
const platformOps = ops.filter((o) => o.op['x-fragment'] === 'platform');
const labOps = ops.filter((o) => o.op['x-fragment'] === 'lab');

const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
ajv.addSchema(bundle, 'bundle');
const toBundle = (n) => (Array.isArray(n) ? n.map(toBundle) : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `bundle${v}` : toBundle(v)])) : n);
const deref = (n) => { let c = n; while (c && c.$ref?.startsWith('#/')) c = c.$ref.slice(2).split('/').reduce((o, k) => o[k], bundle); return c; };
const validates = (schema, value) => { const v = ajv.compile(toBundle(schema)); return v(value) ? [] : v.errors.map((e) => `${e.instancePath} ${e.message}`); };

const AUTH = { cookie: '__Host-vm_session=FAKE-SESSION-ADA', origin: DEFAULT_ORIGIN, 'x-csrf-token': 'fake-csrf-token-for-the-mock-only-0123456789' };
const IDS = { instance_id: 'i-AAAAAAAAAAAAAAAA', attempt_id: 'a-AAAAAAAAAAAAAAAA', challenge_key: 'C01', level: '1', integrity_flag_id: 'g-AAAAAAAAAAAAAAAA' };
const fill = (p) => p.replace(/\{(\w+)\}/g, (_, k) => IDS[k]);
const requestSchemaName = (op) => { const b = op.requestBody && deref(op.requestBody); const s = b?.content?.['application/json']?.schema?.$ref; return s ? s.split('/').pop() : null; };
const exampleFiles = (kind) => fs.readdirSync(path.join(EXAMPLES, kind)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, kind, f), 'utf8')));
const validBody = (schema) => exampleFiles('valid').find((e) => e.schema === schema)?.body;
const needsAuth = (op) => (op.security ?? bundle.security ?? []).some((s) => 'sessionCookie' in s);
const needsCsrf = (op) => (op.security ?? bundle.security ?? []).some((s) => 'csrfHeader' in s);

let mock;
let base;
let lab;
let labMock;
let labBase;

before(async () => {
  mock = createMock({ bundle, errors, origin: DEFAULT_ORIGIN, labUrl: null });
  base = `http://127.0.0.1:${await mock.listen(0)}`;
  lab = await startFakeLab({ origin: DEFAULT_ORIGIN });
  labMock = createMock({ bundle, errors, origin: DEFAULT_ORIGIN, labUrl: lab.url });
  labBase = `http://127.0.0.1:${await labMock.listen(0)}`;
});
after(async () => { await mock.close(); await labMock.close(); lab.stop(); });

async function call(o, { headers = {}, body, rawBody, prefer, url = base } = {}) {
  const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)); // fetch would send the text "undefined"
  let payload = rawBody;
  if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = h['content-type'] ?? 'application/json'; }
  if (prefer) h.prefer = prefer;
  const res = await fetch(url + fill(o.path), { method: o.method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}
const full = (o) => ({ headers: { ...(needsAuth(o.op) ? AUTH : o.method === 'GET' ? {} : { origin: DEFAULT_ORIGIN }) }, body: requestSchemaName(o.op) ? validBody(requestSchemaName(o.op)) : undefined });
const firstSuccess = (op) => Object.keys(op.responses).find((s) => s.startsWith('2'));
const exampleOf = (op, status) => { const r = deref(op.responses[status]); const m = Object.values(r.content || {})[0]; const e = m && (Object.values(m.examples || {})[0] ?? null); return { resp: r, media: m, value: e ? deref(e).value : undefined }; };

test('the bundle has the platform and the lab operations', () => {
  assert.ok(platformOps.length >= 25);
  assert.ok(labOps.length >= 18);
  assert.ok(platformOps.every((o) => o.op.operationId));
});

test('every platform operation answers its first success example with the declared status', async () => {
  for (const o of platformOps) {
    if (o.op['x-pending'] && !needsAuth(o.op)) continue;
    const r = await call(o, full(o));
    const status = firstSuccess(o.op);
    assert.equal(r.status, Number(status), `${o.method} ${o.path}: ${r.text.slice(0, 120)}`);
    assert.match(r.headers.get('cache-control'), /private, no-store/, `${o.method} ${o.path} cache-control`);
    const { media, value } = exampleOf(o.op, status);
    if (media && media.schema && r.json !== null) {
      assert.deepEqual(r.json, value, `${o.method} ${o.path} example`);
      assert.deepEqual(validates(media.schema, r.json), [], `${o.method} ${o.path} schema`);
    }
    if (media && media.schema === undefined) continue;
  }
});

test('every declared answer can be asked for with Prefer: code=NNN and matches its example and schema', async () => {
  let n = 0;
  for (const o of platformOps) {
    for (const status of Object.keys(o.op.responses)) {
      const r = await call(o, { ...full(o), prefer: `code=${status}` });
      assert.equal(r.status, Number(status), `${o.method} ${o.path} ${status}`);
      const { media, value } = exampleOf(o.op, status);
      if (media?.schema && r.json !== null) {
        assert.deepEqual(r.json, value, `${o.method} ${o.path} ${status} example`);
        assert.deepEqual(validates(media.schema, r.json), [], `${o.method} ${o.path} ${status} schema`);
      }
      if (status === '429') assert.ok(r.headers.get('retry-after'), 'a 429 carries Retry-After');
      n++;
    }
  }
  assert.ok(n > 120, `only ${n} answers checked`);
});

test('a named example is selectable: the login answers authenticated or mfa_required', async () => {
  const login = platformOps.find((o) => o.op.operationId === 'createSession');
  const a = await call(login, { ...full(login), prefer: 'example=authenticated' });
  const m = await call(login, { ...full(login), prefer: 'example=mfa_required' });
  assert.equal(a.json.status, 'authenticated');
  assert.equal(m.json.status, 'mfa_required');
});

test('an authenticated route without the session cookie is 401, a state-changing one without a CSRF token or with another Origin is 403', async () => {
  for (const o of platformOps.filter((x) => needsAuth(x.op))) {
    const b = full(o);
    const noCookie = await call(o, { ...b, headers: { ...b.headers, cookie: undefined } });
    assert.equal(noCookie.status, 401, `${o.method} ${o.path} without a cookie`);
    assert.equal(noCookie.json.code, 'AUTH-SESSION-REQUIRED');
    if (o.method !== 'GET') {
      const noCsrf = await call(o, { ...b, headers: { ...b.headers, 'x-csrf-token': undefined } });
      if (needsCsrf(o.op)) assert.equal(noCsrf.status, 403, `${o.method} ${o.path} without a CSRF token`);
      const badOrigin = await call(o, { ...b, headers: { ...b.headers, origin: 'https://evil.example.invalid' } });
      assert.equal(badOrigin.status, 403, `${o.method} ${o.path} with another Origin`);
    }
  }
});

test('a public state-changing route needs the Origin too', async () => {
  for (const o of platformOps.filter((x) => !needsAuth(x.op) && x.method !== 'GET')) {
    const r = await call(o, { headers: { origin: 'https://evil.example.invalid' }, body: validBody(requestSchemaName(o.op)) });
    assert.equal(r.status, 403, `${o.method} ${o.path}`);
  }
});

test('every invalid request example of the contract is answered with 422 by the route that takes it', async () => {
  const bad = exampleFiles('invalid');
  assert.ok(bad.length >= 20);
  for (const ex of bad) {
    const o = platformOps.find((x) => requestSchemaName(x.op) === ex.schema);
    assert.ok(o, `no route takes ${ex.schema}`);
    const r = await call(o, { headers: full(o).headers, body: ex.body });
    assert.equal(r.status, 422, `${ex.schema} ${ex.path}: ${ex.rule}`);
    assert.equal(r.json.code, 'REQ-VALIDATION');
  }
});

test('the body rules: not JSON is 415, malformed JSON is 422, over 64 KiB is 413', async () => {
  const o = platformOps.find((x) => x.op.operationId === 'createSession');
  const h = full(o).headers;
  assert.equal((await call(o, { headers: { ...h, 'content-type': 'text/plain' }, rawBody: 'x' })).status, 415);
  assert.equal((await call(o, { headers: { ...h, 'content-type': 'application/json' }, rawBody: '{ nope' })).status, 422);
  const big = await call(o, { headers: { ...h, 'content-type': 'application/json' }, rawBody: JSON.stringify({ email: 'a@example.invalid', password: 'x'.repeat(70000) }) });
  assert.equal(big.status, 413);
});

test('an unknown route and a wrong method answer IF-8 problems (404 with a code, 405 with Allow)', async () => {
  const nope = await fetch(`${base}/api/v1/no-such-route`);
  assert.equal(nope.status, 404);
  assert.equal((await nope.json()).code, 'REQ-ROUTE-UNKNOWN');
  assert.match(nope.headers.get('content-type'), /problem\+json/);
  const wrong = await fetch(`${base}/api/v1/health`, { method: 'DELETE', headers: { origin: DEFAULT_ORIGIN } });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.get('allow'), /GET/);
});

test('a wrong Origin is answered AUTH-ORIGIN-FORBIDDEN on every state-changing route, also where the 403 default is another cause', async () => {
  const login = platformOps.find((o) => o.op.operationId === 'createSession');
  const r = await call(login, { headers: { origin: 'https://evil.example.invalid' }, body: validBody('LoginRequest') });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'AUTH-ORIGIN-FORBIDDEN');
  for (const o of platformOps.filter((x) => x.method !== 'GET')) {
    const b = full(o);
    const bad = await call(o, { ...b, headers: { ...b.headers, origin: 'https://evil.example.invalid' } });
    assert.equal(bad.json.code, 'AUTH-ORIGIN-FORBIDDEN', `${o.method} ${o.path}`);
  }
});

test('the first step of a login with a second factor sets no cookie', async () => {
  const login = platformOps.find((o) => o.op.operationId === 'createSession');
  const m = await call(login, { ...full(login), prefer: 'example=mfa_required' });
  assert.equal(m.json.status, 'mfa_required');
  assert.equal(m.headers.get('set-cookie'), null);
  const a = await call(login, { ...full(login), prefer: 'example=authenticated' });
  assert.ok(a.headers.get('set-cookie'));
});

test('the 409 and 404 answers of the new codes are served by their routes', async () => {
  const byId = (id) => platformOps.find((o) => o.op.operationId === id);
  for (const [id, status, code] of [['startMfaEnrolment', '409', 'AUTH-MFA-STATE'], ['recordConsent', '409', 'ATT-CONSENT-STALE'], ['getCatalogueChallenge', '404', 'ATT-CHALLENGE-NOT-FOUND']]) {
    const o = byId(id);
    const r = await call(o, { ...full(o), prefer: `code=${status}` });
    assert.equal(r.status, Number(status), id);
    assert.equal(r.json.code, code, id);
  }
});

test('an operation the mock cannot answer is a 500 problem, the server keeps answering', async () => {
  const broken = JSON.parse(JSON.stringify(bundle));
  broken.paths['/api/v1/health'].get.responses = {}; // no success answer: the handler would throw
  const m = createMock({ bundle: broken, errors, origin: DEFAULT_ORIGIN, labUrl: null });
  const url = `http://127.0.0.1:${await m.listen(0)}`;
  try {
    const bad = await fetch(url + '/api/v1/health');
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).code, 'REQ-INTERNAL');
    const fine = await fetch(url + '/api/v1/challenges', { headers: { cookie: '__Host-vm_session=x' } });
    assert.equal(fine.status, 200, 'the server is still up');
  } finally { await m.close(); }
});

test('Prefer for an answer the route does not declare is a clear 422, not a crash', async () => {
  const o = platformOps.find((x) => x.op.operationId === 'getHealth');
  const r = await call(o, { prefer: 'code=418' });
  assert.equal(r.status, 422);
  assert.match(r.json.errors[0].detail, /no 418 answer/);
});

test('login sets the session cookie, logout clears it', async () => {
  const login = platformOps.find((o) => o.op.operationId === 'createSession');
  const r = await call(login, full(login));
  assert.match(r.headers.get('set-cookie'), /__Host-vm_session=FAKE-SESSION-ADA; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const out = platformOps.find((o) => o.op.operationId === 'deleteSession');
  const o = await call(out, full(out));
  assert.equal(o.status, 204);
  assert.match(o.headers.get('set-cookie'), /Max-Age=0/);
});

test('the live stream answers the SSE example, unbuffered', async () => {
  const live = platformOps.find((o) => o.op.operationId === 'openLiveStream');
  const r = await call(live, full(live));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  assert.match(r.text, /^id: \d+-\d+\nevent: attempt\.milestone_reached\ndata: \{/);
});

test('no answer of the platform mock shows a flag, a password hash or a stack trace', async () => {
  for (const o of platformOps) {
    const r = await call(o, full(o));
    assert.doesNotMatch(r.text, /VM\{|argon2|Traceback|at .*\.m?js:\d+/i, `${o.method} ${o.path}`);
  }
});

test('lab routes are forwarded to the fake lab: every lab operation reaches a lab route, a real session reads a seed attempt', async () => {
  const labHeaders = { cookie: '__Host-vm_session=FAKE-SESSION-ADA; __Host-vm_csrf=tok', origin: DEFAULT_ORIGIN, 'x-csrf-token': 'tok' };
  for (const o of labOps) {
    const r = await call(o, { url: labBase, headers: labHeaders, body: o.method === 'POST' ? {} : undefined });
    assert.notEqual(r.json?.code, 'REQ-ROUTE-UNKNOWN', `${o.method} ${o.path} did not reach a lab route`);
    assert.notEqual(r.json?.code, 'REQ-ROUTE-UNKNOWN', `${o.method} ${o.path} was answered by the platform mock`);
    assert.notEqual(r.status, 500, `${o.method} ${o.path}`);
  }
  const attempt = labOps.find((o) => o.op.operationId === 'getAttempt');
  const r = await call(attempt, { url: labBase, headers: labHeaders });
  assert.equal(r.status, 200);
  assert.equal(r.json.attempt_id, 'a-AAAAAAAAAAAAAAAA');
});

test('without a lab the lab routes answer an IF-8 404 instead of hanging', async () => {
  const attempt = labOps.find((o) => o.op.operationId === 'getAttempt');
  const r = await call(attempt, { headers: AUTH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'REQ-ROUTE-UNKNOWN');
});

test('CLI: --help exits 0, an unknown argument 2, a missing value 2, a bad port 2, a missing bundle 1', async () => {
  const io = { log: () => {}, err: () => {} };
  assert.equal((await main(['--help'], io)).code, 0);
  assert.equal((await main(['--nope'], io)).code, 2);
  assert.equal((await main(['--port'], io)).code, 2);
  assert.equal((await main(['--port', '99999', '--no-lab'], io)).code, 2);
  assert.equal((await main(['--bundle', path.join(ROOT, 'no-such-bundle.json'), '--no-lab'], io)).code, 1);
});
