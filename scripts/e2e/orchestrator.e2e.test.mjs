// Black-box end-to-end tests for the orchestrator contract (IF-5), written as an independent consumer: the fake orchestrator runs
// as a separate process, requests are signed by an own implementation of the rule in orchestrator-api.md section 4 (checked first
// against examples/signing-vector.json), and answers are checked by hand against the OpenAPI schemas. The Python client and the
// repository's signing helpers are NOT used. Run: node --test "scripts/e2e/orchestrator.e2e.test.mjs"
// Node built-ins only. The Python suite is run once at the end (needs uv).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'contracts', 'mocks', 'fake-orchestrator', 'server.mjs');
const EXAMPLES = path.join(ROOT, 'contracts', 'orchestrator', 'examples');
const KEY = 'E2E-OWN-PLATFORM-KEY-NOT-REAL-000000'; // a throwaway key for this test only (36 characters)
const STATES = ['requested', 'provisioning', 'starting', 'ready', 'active', 'idle', 'resetting', 'stopping', 'destroyed', 'failed'];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const createExample = readJson(path.join(EXAMPLES, 'valid', 'create.request.json'));
const resetExample = readJson(path.join(EXAMPLES, 'valid', 'reset.request.json'));
const children = [];

// ---- the signing rule, written independently (orchestrator-api.md section 4) ----
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const signingString = (method, target, ts, nonce, body) => ['v1', method.toUpperCase(), target, ts, nonce, sha256hex(body)].join('\n');
const sign = (key, method, target, ts, nonce, body) => 'v1=' + crypto.createHmac('sha256', key).update(signingString(method, target, ts, nonce, body)).digest('hex');
const nowTs = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19) + 'Z';
const newNonce = () => crypto.randomBytes(16).toString('hex');
let counter = 0;
// A fresh, well-formed instance id: "i-" plus 16 Base32 characters.
const newId = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let n = ++counter + 1000;
  let s = '';
  for (let i = 0; i < 16; i++) { s = alphabet[n % 32] + s; n = Math.floor(n / 32); }
  return 'i-' + s;
};
async function startServer(...extra) {
  const child = spawn(process.execPath, [SERVER, '--port', '0', '--key', KEY, ...extra], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake orchestrator did not start')), 15000);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.includes('listening'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).port); }
    });
    child.once('exit', (code) => reject(new Error(`the fake orchestrator exited early with code ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

// One signed call. `bodyObj` undefined means no body. Returns { status, json, text, headers }.
async function call(base, method, target, bodyObj, opt = {}) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = opt.ts ?? nowTs();
  const nonce = opt.nonce ?? newNonce();
  let signature = opt.signature ?? sign(opt.key ?? KEY, method, target, ts, nonce, body);
  const res = await fetch(base + target, {
    method,
    headers: { 'content-type': 'application/json', 'x-vm-timestamp': ts, 'x-vm-nonce': nonce, 'x-vm-signature': signature },
    body: method === 'GET' ? undefined : body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers, sent: { ts, nonce, signature, body } };
}

async function waitFor(base, id, predicate, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await call(base, 'GET', `/v1/instances/${id}`);
    if (last.status === 200 && predicate(last.json)) return last.json;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`the instance did not reach the expected state in time; last answer: ${last && last.text}`);
}

// ---- hand-written checks of the answer schemas (OpenAPI components) ----
const isTs = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v);
function assertStatus(o, where = 'status') {
  const keys = ['instance_id', 'template_id', 'epoch', 'state', 'access', 'access_epoch', 'health', 'error_code', 'host_id', 'hostname', 'created_at', 'updated_at'];
  assert.deepEqual(Object.keys(o).sort(), [...keys].sort(), `${where}: exactly the documented fields`);
  assert.match(o.instance_id, /^i-[A-Z2-7]{16}$/);
  assert.ok(Number.isInteger(o.epoch) && o.epoch >= 1);
  assert.ok(STATES.includes(o.state), o.state);
  assert.ok(['open', 'frozen', 'closed'].includes(o.access));
  assert.ok(Number.isInteger(o.access_epoch) && o.access_epoch >= 0);
  assert.equal(typeof o.health, 'string');
  assert.ok(o.error_code === null || typeof o.error_code === 'string');
  assert.ok(isTs(o.created_at) && isTs(o.updated_at));
}
function assertProblem(r, status, code) {
  assert.equal(r.status, status, r.text);
  assert.match(r.headers.get('content-type') || '', /application\/problem\+json/);
  assert.equal(r.json.code, code, r.text);
  assert.equal(typeof r.json.message, 'string');
  assert.equal(typeof r.json.request_id, 'string');
  for (const k of Object.keys(r.json)) assert.ok(['code', 'message', 'request_id', 'field'].includes(k), `unexpected key ${k}`);
}
const secretMarkers = [createExample.event_key, createExample.seed, 'VM{', createExample.flag_digests[0].sha256];

let base;
before(async () => { base = await startServer(); });
after(() => { for (const c of children) if (c.exitCode === null) c.kill(); });

test('the signing rule written here reproduces the signing vector of the contract', () => {
  const v = readJson(path.join(EXAMPLES, 'signing-vector.json'));
  assert.equal(sha256hex(v.body), v.body_sha256);
  assert.equal(signingString(v.method, v.target, v.timestamp, v.nonce, v.body), v.signing_string);
  assert.equal(sign(v.key, v.method, v.target, v.timestamp, v.nonce, v.body), v.signature);
});

test('create: 202, the instance reaches ready, a repeat is 200, another body with the same identity is 409', async () => {
  const id = newId();
  const body = { ...clone(createExample), instance_id: id };
  const first = await call(base, 'POST', '/v1/instances', body);
  assert.equal(first.status, 202, first.text);
  assertStatus(first.json, 'create answer');
  assert.equal(first.json.instance_id, id);
  assert.equal(first.json.epoch, 1);
  const ready = await waitFor(base, id, (s) => s.state === 'ready');
  assertStatus(ready, 'get answer');
  assert.equal(ready.health, 'healthy');
  const again = await call(base, 'POST', '/v1/instances', body);
  assert.equal(again.status, 200, again.text);
  assertStatus(again.json);
  const other = { ...clone(body), seed: 'ANOTHER-FAKE-SEED-NOT-REAL-0000000' };
  assertProblem(await call(base, 'POST', '/v1/instances', other), 409, 'ORCH-REQUEST-MISMATCH');
});

test('no GET answer contains a flag, decoy, digest, seed or event key', async () => {
  const id = newId();
  await call(base, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id });
  await waitFor(base, id, (s) => s.state === 'ready');
  const answers = [await call(base, 'GET', `/v1/instances/${id}`), await call(base, 'GET', '/v1/instances'), await call(base, 'GET', '/v1/host')];
  for (const a of answers) {
    assert.equal(a.status, 200);
    for (const marker of secretMarkers) assert.ok(!a.text.includes(marker), `a GET answer holds ${marker.slice(0, 12)}...`);
    for (const word of ['"flags"', '"decoys"', '"flag_digests"', '"seed"', '"event_key"']) assert.ok(!a.text.includes(word), `a GET answer names ${word}`);
  }
});

test('owner_hash and first_seq: required and checked on create, first_seq on reset, no owner_hash in a reset, nothing returned by a GET', async () => {
  for (const [mutate, field] of [
    [(b) => { delete b.owner_hash; }, '/owner_hash'], [(b) => { b.owner_hash = 'F'.repeat(64); }, '/owner_hash'],
    [(b) => { b.owner_hash = 'a'.repeat(63); }, '/owner_hash'], [(b) => { delete b.first_seq; }, '/first_seq'],
    [(b) => { b.first_seq = 0; }, '/first_seq'], [(b) => { b.first_seq = '1'; }, '/first_seq'],
  ]) {
    const id = newId();
    const body = { ...clone(createExample), instance_id: id };
    mutate(body);
    const r = await call(base, 'POST', '/v1/instances', body);
    assertProblem(r, 422, 'ORCH-VALIDATION');
    assert.equal(r.json.field, field);
    assertProblem(await call(base, 'GET', `/v1/instances/${id}`), 404, 'ORCH-INSTANCE-NOT-FOUND');
  }
  const id = newId();
  const body = { ...clone(createExample), instance_id: id, first_seq: 777001 };
  assert.equal((await call(base, 'POST', '/v1/instances', body)).status, 202);
  await waitFor(base, id, (s) => s.state === 'ready');
  // owner_hash and first_seq are part of the identity of a request
  assertProblem(await call(base, 'POST', '/v1/instances', { ...clone(body), first_seq: 777002 }), 409, 'ORCH-REQUEST-MISMATCH');
  assertProblem(await call(base, 'POST', '/v1/instances', { ...clone(body), owner_hash: 'b'.repeat(64) }), 409, 'ORCH-REQUEST-MISMATCH');
  const noSeq = clone(resetExample);
  delete noSeq.first_seq;
  const r1 = await call(base, 'POST', `/v1/instances/${id}/reset`, noSeq);
  assertProblem(r1, 422, 'ORCH-VALIDATION');
  assert.equal(r1.json.field, '/first_seq');
  const r2 = await call(base, 'POST', `/v1/instances/${id}/reset`, { ...clone(resetExample), owner_hash: body.owner_hash });
  assertProblem(r2, 422, 'ORCH-VALIDATION');
  assert.equal(r2.json.field, '/owner_hash');
  assert.equal((await call(base, 'POST', `/v1/instances/${id}/reset`, { ...clone(resetExample), first_seq: 888002 })).status, 202);
  await waitFor(base, id, (s) => s.state === 'ready' && s.epoch === 2);
  for (const a of [await call(base, 'GET', `/v1/instances/${id}`), await call(base, 'GET', '/v1/instances'), await call(base, 'GET', '/v1/host')]) {
    assert.equal(a.status, 200);
    for (const marker of [body.owner_hash, '777001', '888002', 'owner', 'first_seq']) assert.ok(!a.text.includes(marker), `a GET answer holds ${marker}`);
  }
});

test('a body that names an image, command, volume, port or env is refused with 422 and nothing is created; an unknown template is 422', async () => {
  for (const [name, value] of [['image', 'evil:latest'], ['command', 'sh'], ['volumes', ['/:/host']], ['ports', [22]], ['env', { A: 'b' }]]) {
    const id = newId();
    const r = await call(base, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id, [name]: value });
    assertProblem(r, 422, 'ORCH-FIELD-FORBIDDEN');
    assert.equal(r.json.field, name);
    assertProblem(await call(base, 'GET', `/v1/instances/${id}`), 404, 'ORCH-INSTANCE-NOT-FOUND');
  }
  const id = newId();
  assertProblem(await call(base, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id, template_id: 'no-such-template' }), 422, 'ORCH-TEMPLATE-UNKNOWN');
  assertProblem(await call(base, 'GET', `/v1/instances/${id}`), 404, 'ORCH-INSTANCE-NOT-FOUND');
});

test('a bad signature, a stale timestamp and a replayed nonce are refused with 401 and change nothing', async () => {
  const id = newId();
  const body = { ...clone(createExample), instance_id: id };
  const good = sign(KEY, 'POST', '/v1/instances', nowTs(), 'a'.repeat(32), JSON.stringify(body));
  const flipped = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  assertProblem(await call(base, 'POST', '/v1/instances', body, { signature: flipped }), 401, 'ORCH-BAD-SIGNATURE');
  assertProblem(await call(base, 'POST', '/v1/instances', body, { ts: nowTs(-300) }), 401, 'ORCH-BAD-SIGNATURE');
  assertProblem(await call(base, 'POST', '/v1/instances', body, { key: KEY + 'x' }), 401, 'ORCH-BAD-SIGNATURE');
  const nonce = newNonce();
  const first = await call(base, 'GET', '/v1/host', undefined, { nonce });
  assert.equal(first.status, 200);
  const replay = await call(base, 'GET', '/v1/host', undefined, { nonce, ts: first.sent.ts, signature: first.sent.signature });
  assertProblem(replay, 401, 'ORCH-BAD-SIGNATURE');
  assertProblem(await call(base, 'GET', `/v1/instances/${id}`), 404, 'ORCH-INSTANCE-NOT-FOUND');
});

test('access: open, frozen and closed with a growing access epoch work; an older access epoch is 409', async () => {
  const id = newId();
  await call(base, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id });
  await waitFor(base, id, (s) => s.state === 'ready');
  for (const [access, epoch] of [['open', 1], ['frozen', 2], ['closed', 3]]) {
    const r = await call(base, 'POST', `/v1/instances/${id}/access`, { access, access_epoch: epoch });
    assert.equal(r.status, 200, r.text);
    assertStatus(r.json);
    assert.equal(r.json.access, access);
    assert.equal(r.json.access_epoch, epoch);
  }
  assertProblem(await call(base, 'POST', `/v1/instances/${id}/access`, { access: 'open', access_epoch: 2 }), 409, 'ORCH-STALE-ACCESS-EPOCH');
  assert.equal((await call(base, 'GET', `/v1/instances/${id}`)).json.access, 'closed');
});

test('reset: a ready instance gets epoch + 1 and goes through resetting and provisioning back to ready; a wrong epoch is 409', async () => {
  const slow = await startServer('--step-delay-ms', '120');
  const id = newId();
  assert.equal((await call(slow, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id })).status, 202);
  await waitFor(slow, id, (s) => s.state === 'ready', 15000);
  assertProblem(await call(slow, 'POST', `/v1/instances/${id}/reset`, { ...clone(resetExample), epoch: 5 }), 409, 'ORCH-STALE-EPOCH');
  const r = await call(slow, 'POST', `/v1/instances/${id}/reset`, { ...clone(resetExample), epoch: 2 });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.epoch, 2);
  const seen = new Set([r.json.state]);
  const end = Date.now() + 15000;
  let last;
  while (Date.now() < end) {
    last = (await call(slow, 'GET', `/v1/instances/${id}`)).json;
    seen.add(last.state);
    if (last.state === 'ready' && last.epoch === 2) break;
    await new Promise((x) => setTimeout(x, 10));
  }
  assert.equal(last.state, 'ready');
  assert.equal(last.epoch, 2);
  assert.ok(seen.has('resetting') || seen.has('provisioning'), `states seen: ${[...seen].join(', ')}`);
  for (const s of seen) assert.ok(STATES.includes(s));
  assert.equal((await call(slow, 'POST', `/v1/instances/${id}/reset`, { ...clone(resetExample), epoch: 2 })).status, 200, 'the same reset again is a repeat');
});

test('destroy: 202 then 200 on a repeat, and a destroyed id cannot be created again (409)', async () => {
  const id = newId();
  const body = { ...clone(createExample), instance_id: id };
  await call(base, 'POST', '/v1/instances', body);
  await waitFor(base, id, (s) => s.state === 'ready');
  const first = await call(base, 'POST', `/v1/instances/${id}/destroy`);
  assert.ok([200, 202].includes(first.status), first.text);
  const gone = await waitFor(base, id, (s) => s.state === 'destroyed');
  assertStatus(gone);
  const second = await call(base, 'POST', `/v1/instances/${id}/destroy`);
  assert.equal(second.status, 200, second.text);
  assertProblem(await call(base, 'POST', '/v1/instances', body), 409, 'ORCH-INSTANCE-EXISTS');
});

test('list: label filters, cursor paging, an unknown label is 422; host answers capacity', async () => {
  const lbase = await startServer();
  const ids = [newId(), newId(), newId()];
  for (const id of ids) {
    assert.equal((await call(lbase, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id })).status, 202);
  }
  const page1 = await call(lbase, 'GET', '/v1/instances?limit=2');
  assert.equal(page1.status, 200, page1.text);
  assert.equal(page1.json.items.length, 2);
  assert.equal(typeof page1.json.next_cursor, 'string');
  for (const it of page1.json.items) assertStatus(it, 'list item');
  const page2 = await call(lbase, 'GET', `/v1/instances?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  assert.equal(page2.status, 200, page2.text);
  assert.equal(page2.json.items.length, 1);
  assert.equal(page2.json.next_cursor, null);
  assert.deepEqual([...page1.json.items, ...page2.json.items].map((i) => i.instance_id), [...ids].sort(), 'ordered by instance id, no gaps');
  const one = await call(lbase, 'GET', `/v1/instances?instance=${ids[0]}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.items.map((i) => i.instance_id), [ids[0]]);
  const byTemplate = await call(lbase, 'GET', '/v1/instances?template=shop-v0');
  assert.equal(byTemplate.json.items.length, 3);
  assertProblem(await call(lbase, 'GET', '/v1/instances?bogus=1'), 422, 'ORCH-LABEL-UNKNOWN');
  assertProblem(await call(lbase, 'GET', '/v1/instances?limit=0'), 422, 'ORCH-VALIDATION');
  const host = await call(lbase, 'GET', '/v1/host');
  assert.equal(host.status, 200);
  for (const k of ['host_id', 'kind', 'capacity_memory_mb', 'used_memory_mb', 'instances', 'health']) assert.ok(k in host.json, `host answer lacks ${k}`);
  assert.equal(host.json.instances, 3);
  assert.equal(host.json.used_memory_mb, 3 * createExample.limits.memory_mb);
  assert.ok(host.json.used_memory_mb <= host.json.capacity_memory_mb);
});

test('a host with little capacity answers 429 ORCH-BUSY with Retry-After and creates nothing', async () => {
  const small = await startServer('--capacity-mb', String(createExample.limits.memory_mb + 100));
  assert.equal((await call(small, 'POST', '/v1/instances', { ...clone(createExample), instance_id: newId() })).status, 202);
  const id = newId();
  const busy = await call(small, 'POST', '/v1/instances', { ...clone(createExample), instance_id: id });
  assertProblem(busy, 429, 'ORCH-BUSY');
  assert.ok(busy.headers.get('retry-after'), 'Retry-After is present');
  assertProblem(await call(small, 'GET', `/v1/instances/${id}`), 404, 'ORCH-INSTANCE-NOT-FOUND');
});

test('the Python suite (protocol on both hosts, HTTP service, contract) still passes', { timeout: 600000 }, () => {
  const r = spawnSync('uv', ['run', '--locked', '--package', 'vulnmart-api', 'pytest', '-q'], { cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 540000 });
  assert.equal(r.status, 0, (r.stdout || '').slice(-3000) + (r.stderr || '').slice(-1000));
  assert.match(r.stdout, /\d+ passed/);
});
