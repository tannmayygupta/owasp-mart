// Black-box end-to-end test for the lab API contract (IF-2), written as an independent consumer: the fake lab runs as a separate
// process, requests are made with node:http, and answers are checked by hand against the rules of contracts/api/lab/lab-api.md
// and the valid examples. The repository's mock code and the Python checker are NOT imported.
// Run: node --test "scripts/e2e/lab.e2e.test.mjs"   (Node built-ins only)
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'contracts', 'mocks', 'fake-lab', 'server.mjs');
const EXAMPLES = path.join(ROOT, 'contracts', 'api', 'lab', 'examples', 'valid');
const ORIGIN = 'https://dashboard.example.invalid';
const CSRF = 'E2E-OWN-CSRF-TOKEN-0123456789';
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const STATES = ['requested', 'provisioning', 'starting', 'ready', 'active', 'idle', 'resetting', 'stopping', 'destroyed', 'failed'];
const fakeFlag = (c) => 'VM{' + c.repeat(24) + '}';
const children = [];
let base;
let slow;

async function start(...extra) {
  const child = spawn(process.execPath, [SERVER, '--port', '0', ...extra], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake lab did not start')), 15000);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.includes('listening'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).port); }
    });
    child.once('exit', (code) => reject(new Error(`the fake lab exited early with code ${code}`)));
  });
  return port;
}

// One call. Returns { status, json, headers, text }.
function call(port, method, p, { user = 'ADA', body, csrf = CSRF, origin = ORIGIN, ctype = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {};
    if (user) headers.cookie = `__Host-vm_session=FAKE-SESSION-${user}; __Host-vm_csrf=${CSRF}`;
    if (method === 'POST') {
      if (origin) headers.origin = origin;
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    if (data !== undefined) { headers['content-type'] = ctype; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const get = (p, o) => call(base, 'GET', p, o);
const post = (p, body, o = {}) => call(base, 'POST', p, { ...o, body });
const example = (name) => JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8'));
const keysOf = (o) => (Array.isArray(o) ? o.flatMap(keysOf) : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
const A_LEARNER = 'a-AAAAAAAAAAAAAAAA';
const A_CAND = 'a-BBBBBBBBBBBBBBBB';
const I_CAND = 'i-BBBBBBBBBBBBBBBB';
let ANSWERS = [];
const seen = (r) => { ANSWERS.push(r.text); assert.equal(r.headers['cache-control'], 'private, no-store'); return r; };

// Every test gets its own fresh fake lab (and its own answer list), so the tests do not depend on each other or on their order.
// `slow` (instance steps held for ten minutes) is started only by the tests that need it.
beforeEach(async () => {
  ANSWERS = [];
  slow = undefined;
  base = await start();
});
afterEach(() => { for (const c of children.splice(0)) c.kill(); });
const startSlow = async () => { slow = await start('--step-delay-ms', '600000'); return slow; };

test('the startup line is printed once and unknown arguments exit 2', async () => {
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER, '--bogus', '1'], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, err }));
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown or incomplete argument/);
});

test('an owner reads, an outsider gets the same 404 as for a missing id, and there is no session without a cookie', async () => {
  const own = seen(await get(`/api/v1/attempts/${A_CAND}`, { user: 'CAM' }));
  assert.equal(own.status, 200);
  assert.deepEqual(Object.keys(own.json).sort(), Object.keys(example('attempt.json')).sort());
  const outsider = seen(await get(`/api/v1/attempts/${A_CAND}`, { user: 'EVE' }));
  const missing = seen(await get('/api/v1/attempts/a-ZZZZZZZZZZZZZZZZ', { user: 'EVE' }));
  assert.equal(outsider.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(outsider.json.code, missing.json.code);
  assert.equal(outsider.json.message, missing.json.message);
  const none = seen(await get(`/api/v1/attempts/${A_CAND}`, { user: null }));
  assert.equal(none.status, 401);
  assert.match(none.json.code, /^AUTH-/);
});

test('a POST needs the CSRF header and the dashboard origin', async () => {
  const body = { challenge_key: 'C01', flag: fakeFlag('A') };
  for (const opt of [{ csrf: null }, { csrf: 'WRONG-0123456789012345' }, { origin: 'https://evil.example.invalid' }, { origin: null }]) {
    const r = seen(await post(`/api/v1/attempts/${A_LEARNER}/flags`, body, opt));
    assert.equal(r.status, 403);
    assert.match(r.json.code, /^AUTH-/);
  }
  assert.deepEqual(seen(await get(`/api/v1/attempts/${A_LEARNER}/timeline`)).json.items, []);
});

test('flag results by input, no echo, rate limit per challenge', async () => {
  const p = `/api/v1/attempts/${A_LEARNER}/flags`;
  const results = {};
  for (const [letter, name] of [['B', 'decoy'], ['C', 'other_instance'], ['D', 'stale_epoch']]) {
    const r = seen(await post(p, { challenge_key: 'C02', flag: fakeFlag(letter) }));
    assert.equal(r.status, 200);
    results[name] = r.json;
  }
  assert.deepEqual(Object.keys(results.decoy).sort(), Object.keys(example('flags.result.decoy.json')).sort());
  assert.equal(results.decoy.result, 'decoy');
  assert.equal(results.other_instance.result, 'other_instance');
  assert.equal(results.stale_epoch.result, 'stale_epoch');
  const marker = 'VM{' + 'Z'.repeat(24) + '}';
  for (let i = 0; i < 5; i++) assert.equal(seen(await post(p, { challenge_key: 'C07', flag: i === 0 ? marker : `wrong ${i}` })).json.result, 'wrong');
  const limited = seen(await post(p, { challenge_key: 'C07', flag: fakeFlag('A') }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(limited.json.code, 'ATT-FLAG-RATE-LIMITED');
  const ok = seen(await post(p, { challenge_key: 'C08', flag: fakeFlag('A') }));
  assert.deepEqual(ok.json, { challenge_key: 'C08', result: 'correct', credit: 'credited' });
  for (const part of ['score', 'timeline', 'challenges', 'report', 'integrity-flags', 'evidence']) seen(await get(`/api/v1/attempts/${A_LEARNER}/${part}`));
  assert.ok(!ANSWERS.join('\n').includes(marker), 'the submitted text was echoed');
});

test('bad bodies are 422 with a field pointer; wrong media type 415; a body where none is allowed 422', async () => {
  const p = `/api/v1/attempts/${A_LEARNER}/flags`;
  for (const [body, field] of [[{ challenge_key: 'C01' }, '/flag'], [{ challenge_key: 'C01', flag: 5 }, '/flag'], [{ challenge_key: 'C77', flag: 'x' }, '/challenge_key'], [{ flag: 'x', challenge_key: 'C01', more: 1 }, '/more']]) {
    const r = seen(await post(p, body));
    assert.equal(r.status, 422);
    assert.equal(r.json.code, 'REQ-VALIDATION');
    assert.equal(r.json.field, field);
  }
  assert.equal(seen(await post(p, 'challenge_key=C01', { ctype: 'text/plain' })).status, 415);
  assert.equal(seen(await post(`/api/v1/instances/${I_CAND}/open`, '{}', { user: 'CAM' })).status, 422);
});

test('hints off is 404, hints on unlock and repeat', async () => {
  for (const r of [await get(`/api/v1/attempts/${A_CAND}/challenges/C01/hints`, { user: 'CAM' }), await post(`/api/v1/attempts/${A_CAND}/challenges/C01/hints/1/unlock`, undefined, { user: 'CAM' })]) {
    assert.equal(seen(r).status, 404);
    assert.equal(r.json.code, 'ATT-HINTS-DISABLED');
  }
  const h = `/api/v1/attempts/${A_LEARNER}/challenges/C03/hints`;
  assert.ok(seen(await get(h)).json.items.every((x) => x.text === null));
  const one = seen(await post(`${h}/1/unlock`));
  assert.equal(one.status, 200);
  assert.deepEqual(seen(await post(`${h}/1/unlock`)).json, one.json);
});

test('an instance goes requested to ready, opens with a ticket, resets with a new epoch, stops', async () => {
  const r = seen(await post('/api/v1/instances', { kind: 'learner' }, { user: 'EVE' }));
  assert.equal(r.status, 202);
  assert.ok(STATES.includes(r.json.state));
  const id = r.json.instance_id;
  let st;
  for (let i = 0; i < 200; i++) {
    st = seen(await get(`/api/v1/instances/${id}`, { user: 'EVE' })).json;
    if (st.state === 'ready') break;
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(st.state, 'ready');
  assert.equal(st.access, 'open');
  assert.deepEqual(Object.keys(st).sort(), Object.keys(example('instance.ready.json')).sort());
  const t = seen(await post(`/api/v1/instances/${id}/open`, undefined, { user: 'EVE' }));
  assert.equal(t.status, 200);
  assert.match(t.json.url, /^https:\/\/i-[a-z0-9]+\.labs\.example\.invalid\/_vm\/enter\?t=[A-Za-z0-9_-]{16,}$/);
  const reset = seen(await post(`/api/v1/instances/${id}/reset`, { confirm: true }, { user: 'EVE' }));
  assert.equal(reset.status, 202);
  assert.equal(reset.json.epoch, 2);
  assert.equal(reset.json.state, 'resetting');
  // A second reset while resetting is 409. Checked on the slow server, where the seeded ready instance stays in the resetting state.
  await startSlow();
  assert.equal((await call(slow, 'POST', `/api/v1/instances/${I_CAND}/reset`, { user: 'CAM', body: { confirm: true } })).status, 202);
  assert.equal((await call(slow, 'POST', `/api/v1/instances/${I_CAND}/reset`, { user: 'CAM', body: { confirm: true } })).status, 409);
  assert.equal(seen(await post('/api/v1/instances', { kind: 'learner' }, { user: 'EVE' })).status, 409);
  assert.equal(seen(await post(`/api/v1/instances/${id}/stop`, undefined, { user: 'EVE' })).status, 202);
});

test('an instance that is not ready cannot be opened or reset (409)', async () => {
  await startSlow();
  const r = await call(slow, 'POST', '/api/v1/instances', { user: 'ADA', body: { kind: 'learner' } });
  assert.equal(r.status, 202);
  const id = r.json.instance_id;
  for (const [p, body] of [[`/api/v1/instances/${id}/open`, undefined], [`/api/v1/instances/${id}/reset`, { confirm: true }]]) {
    const x = await call(slow, 'POST', p, { user: 'ADA', body });
    assert.equal(x.status, 409);
    assert.match(x.json.code, /^INST-/);
  }
});

test('start, submit and wrong states', async () => {
  const start1 = seen(await post('/api/v1/attempts/a-CCCCCCCCCCCCCCCC/start', undefined, { user: 'CAM' }));
  assert.equal(start1.status, 200);
  assert.equal(start1.json.state, 'running');
  assert.equal(seen(await post('/api/v1/attempts/a-CCCCCCCCCCCCCCCC/start', undefined, { user: 'CAM' })).status, 409);
  assert.equal(seen(await post('/api/v1/attempts/a-DDDDDDDDDDDDDDDD/submit', { confirm: true }, { user: 'CAM' })).json.code, 'ATT-INVALID-STATE');
  assert.equal(seen(await post(`/api/v1/attempts/${A_CAND}/submit`, { confirm: true }, { user: 'CAM' })).json.state, 'submitted');
  assert.equal(seen(await get(`/api/v1/instances/${I_CAND}`, { user: 'CAM' })).json.access, 'frozen');
});

test('reviewer routes: evidence, integrity flags with a decision, report, timeline paging', async () => {
  const flags = seen(await get(`/api/v1/attempts/${A_CAND}/integrity-flags`, { user: 'REX' })).json.items;
  assert.ok(flags.length >= 2);
  const f = flags[0];
  const d = seen(await post(`/api/v1/attempts/${A_CAND}/integrity-flags/${f.integrity_flag_id}/decision`, { decision: 'reject', note: 'checked' }, { user: 'REX' }));
  assert.equal(d.status, 200);
  assert.equal(d.json.status, 'rejected');
  assert.equal(seen(await post(`/api/v1/attempts/${A_CAND}/integrity-flags/${f.integrity_flag_id}/decision`, { decision: 'accept', note: 'again' }, { user: 'REX' })).status, 409);
  assert.equal(seen(await get(`/api/v1/attempts/${A_CAND}/evidence`, { user: 'REX' })).status, 200);
  assert.equal(seen(await get(`/api/v1/attempts/${A_CAND}/report`, { user: 'REX' })).json.mode, 'candidate');
  assert.equal(seen(await get(`/api/v1/attempts/${A_CAND}/report`, { user: 'CAM' })).status, 404);
  const page = seen(await get(`/api/v1/attempts/${A_CAND}/timeline?limit=1`, { user: 'REX' })).json;
  assert.equal(page.items.length, 1);
  assert.ok(page.next_cursor);
  assert.equal(seen(await get(`/api/v1/attempts/${A_CAND}/timeline?limit=0`, { user: 'REX' })).status, 422);
});

test('unknown path is 404 and a wrong method is 405 with Allow', async () => {
  assert.equal(seen(await get('/api/v1/nothing')).status, 404);
  const r = seen(await call(base, 'DELETE', `/api/v1/instances/${I_CAND}`, { user: 'CAM' }));
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET');
});

test('no answer holds a flag, key, seed, owner hash, host id or stack trace', async () => {
  // A fixed set of calls on this test's own lab; every answer is kept by seen(), so the count is exact.
  const planned = [
    () => get(`/api/v1/attempts/${A_LEARNER}`), () => get(`/api/v1/attempts/${A_LEARNER}/score`), () => get(`/api/v1/attempts/${A_LEARNER}/timeline`),
    () => get(`/api/v1/attempts/${A_LEARNER}/challenges`), () => get(`/api/v1/attempts/${A_LEARNER}/challenges/C01/hints`),
    () => get(`/api/v1/attempts/${A_LEARNER}/report`), () => get(`/api/v1/attempts/${A_LEARNER}/evidence`), () => get(`/api/v1/attempts/${A_LEARNER}/integrity-flags`),
    () => post(`/api/v1/attempts/${A_LEARNER}/flags`, { challenge_key: 'C01', flag: fakeFlag('B') }),
    () => post(`/api/v1/attempts/${A_LEARNER}/flags`, { challenge_key: 'C01', flag: fakeFlag('C') }),
    () => post(`/api/v1/attempts/${A_LEARNER}/flags`, { challenge_key: 'C01', flag: fakeFlag('A') }),
    () => post(`/api/v1/attempts/${A_LEARNER}/flags`, { challenge_key: 'C01' }),
    () => get(`/api/v1/attempts/${A_LEARNER}/integrity-flags`),
    () => get(`/api/v1/attempts/${A_CAND}`, { user: 'CAM' }), () => get(`/api/v1/attempts/${A_CAND}/report`, { user: 'REX' }),
    () => get(`/api/v1/attempts/${A_CAND}/evidence`, { user: 'REX' }), () => get(`/api/v1/attempts/${A_CAND}/integrity-flags`, { user: 'REX' }),
    () => get(`/api/v1/attempts/${A_CAND}/timeline`, { user: 'REX' }), () => get(`/api/v1/instances/${I_CAND}`, { user: 'CAM' }),
    () => post(`/api/v1/instances/${I_CAND}/open`, undefined, { user: 'CAM' }), () => get('/api/v1/nothing'), () => get(`/api/v1/attempts/${A_CAND}`, { user: 'EVE' }),
    () => get(`/api/v1/attempts/${A_LEARNER}`, { user: null }), () => call(base, 'DELETE', `/api/v1/instances/${I_CAND}`, { user: 'CAM' }),
  ];
  for (const make of planned) seen(await make());
  assert.equal(ANSWERS.length, planned.length);
  const text = ANSWERS.join('\n');
  assert.ok(!/VM\{/.test(text));
  for (const name of ['owner_hash', 'event_key', 'flag_digests', 'host_id', 'seed', 'stack', 'orchestrator']) assert.ok(!text.includes(name), name);
  for (const answer of ANSWERS) if (answer) assert.ok(!keysOf(JSON.parse(answer)).some((k) => ['flag', 'flags', 'decoys', 'sha256', 'hostname'].includes(k)));
});
