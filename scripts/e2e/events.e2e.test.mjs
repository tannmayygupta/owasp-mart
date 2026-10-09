// Black-box end-to-end tests for the instance event contract (IF-4): a real fake-ingest server in a separate process,
// signed requests built the way app-events.md section 4 says (the helper in the repository is NOT used), and the derived
// posted-body schema checked with Ajv. Run: node --test "scripts/e2e/events.e2e.test.mjs". Node built-ins and the repo's Ajv only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVENTS = path.join(ROOT, 'contracts', 'events');
const SERVER = path.join(ROOT, 'contracts', 'mocks', 'fake-ingest', 'server.mjs');
const KEY = 'E2E-OWN-FAKE-KEY-NOT-REAL-00000000'; // a throwaway key for this test only
const INSTANCE = 'i-AAAAAAAAAAAAAAAA'; // the server's default instance
// A nested node process must not inherit the parent test runner's context.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const temps = [];

// The signing rule of app-events.md section 4, written independently of contracts/mocks/fake-ingest/sign.mjs.
const sign = (body, instance, seq) => {
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  return 'v1=' + crypto.createHmac('sha256', KEY).update(`${instance}\n${seq}\n${digest}`).digest('hex');
};

let child;
let base;
const events = readdirSync(path.join(EVENTS, 'examples', 'valid', 'instance-events'))
  .map((f) => readJson(path.join(EVENTS, 'examples', 'valid', 'instance-events', f)))
  .sort((a, b) => a.seq - b.seq);
const clone = (o) => JSON.parse(JSON.stringify(o));

before(async () => {
  child = spawn(process.execPath, [SERVER, '--key', KEY, '--port', '0'], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake ingest did not start')), 15000);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/listening on (http:\/\/[\d.]+:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('exit', (code) => reject(new Error(`the fake ingest exited early with code ${code}`)));
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await done;
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// POST one event the way a sidecar would. Returns { status, text, json }.
async function post(body, { instance = INSTANCE, seq, signature } = {}) {
  const res = await fetch(`${base}/internal/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vm-signature': signature ?? sign(body, instance, seq) },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json, res };
}
const postEvent = (ev, opts = {}) => {
  const body = JSON.stringify(ev);
  return post(body, { instance: ev.instance_id, seq: ev.seq, ...opts });
};
const stored = async () => (await (await fetch(`${base}/_fake/events`)).json());

test('every valid example type is accepted (202) and an identical repeat is a duplicate (200)', async () => {
  assert.equal(events.length, 29, 'one valid example per event type');
  for (const ev of events) {
    const first = await postEvent(ev);
    assert.equal(first.status, 202, `${ev.type}: ${first.text}`);
    const again = await postEvent(ev);
    assert.equal(again.status, 200, `${ev.type} duplicate: ${again.text}`);
  }
  const list = await stored();
  assert.equal(list.length, 29, 'duplicates are not stored twice');
  assert.deepEqual(new Set(list.map((e) => e.type)), new Set(events.map((e) => e.type)));
});

test('the same (instance_id, seq) with a different body is refused with 409 and nothing new is stored', async () => {
  const before = (await stored()).length;
  const other = clone(events[0]);
  other.ts = '2026-01-01T00:59:59Z';
  const r = await postEvent(other);
  assert.equal(r.status, 409, r.text);
  assert.equal((await stored()).length, before);
});

test('a bad signature and a wrong instance are refused with 401 and the answer never repeats the signature', async () => {
  const ev = clone(events[0]);
  ev.seq = 500;
  const body = JSON.stringify(ev);
  const good = sign(body, INSTANCE, 500);
  const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  const r1 = await post(body, { signature: bad });
  assert.equal(r1.status, 401, r1.text);
  assert.ok(!r1.text.includes(bad), 'the answer must not echo the signature');
  assert.ok(!r1.text.includes(good), 'the answer must not reveal the right signature');
  const wrong = clone(ev);
  wrong.instance_id = 'i-BBBBBBBBBBBBBBBB'; // well formed, but this ingest has no key for it
  const r2 = await postEvent(wrong);
  assert.equal(r2.status, 401, r2.text);
  assert.equal(r2.json && r2.json.status, 401);
  assert.equal(r2.text.replace(/i-B+/g, ''), r2.text, 'the answer does not name the instance it does not know');
});

test('an oversize body is refused with 413 and the server keeps working', async () => {
  const body = JSON.stringify({ filler: 'x'.repeat(20 * 1024) });
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/internal/v1/events`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-vm-signature': 'v1=' + '0'.repeat(64) } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end(body);
  });
  assert.equal(status, 413);
  const next = clone(events[1]);
  next.seq = 501;
  assert.equal((await postEvent(next)).status, 202, 'the next request is answered normally');
});

test('a flag-like string in data is refused with 422 in any letter case, and the answer never echoes it', async () => {
  const variants = ['VM{ZZZZZZZZZZZZZZZZZZZZZZZZ}', 'vm{ZZZZZZZZZZZZZZZZZZZZZZZZ}', 'VM%7BZZZZZZZZZZZZZZZZZZZZZZZZ%7D'];
  let seq = 600;
  for (const flag of variants) {
    const ev = clone(events.find((e) => e.type === 'proxy.request'));
    ev.seq = seq++;
    ev.data.route_template = `/probe/${flag}`;
    const r = await postEvent(ev);
    assert.equal(r.status, 422, `${flag}: ${r.text}`);
    assert.ok(!r.text.includes('ZZZZZZZZ'), 'the answer must not echo the flag-like value');
  }
});

test('an unknown type and an extra field are refused with 422 and the answer names a JSON path', async () => {
  const unknown = clone(events[0]);
  unknown.seq = 700;
  unknown.type = 'shop.not_a_real_event';
  const r1 = await postEvent(unknown);
  assert.equal(r1.status, 422, r1.text);
  assert.match(r1.text, /\/type|type/);
  const extra = clone(events[0]);
  extra.seq = 701;
  extra.surprise = 1;
  const r2 = await postEvent(extra);
  assert.equal(r2.status, 422, r2.text);
  assert.match(r2.text, /\/surprise|surprise/);
});

test('GET is answered 405 and a client that aborts in the middle of a body does not stop the server', async () => {
  const get = await fetch(`${base}/internal/v1/events`);
  assert.equal(get.status, 405);
  await get.text();
  const u = new URL(base);
  await new Promise((resolve) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`POST /internal/v1/events HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\nX-VM-Signature: v1=${'0'.repeat(64)}\r\n\r\n{"partial":`);
      setTimeout(() => { sock.destroy(); resolve(); }, 100);
    });
    sock.once('error', resolve);
  });
  const next = clone(events[2]);
  next.seq = 800;
  assert.equal((await postEvent(next)).status, 202, 'the server answers after the abort');
});

test('the posted-body schema accepts every valid posted example and refuses source sidecar', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(readJson(path.join(EVENTS, 'instance-events.posted.schema.json')));
  const dir = path.join(EVENTS, 'examples', 'valid', 'posted');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 6, `posted examples: ${files.length}`);
  for (const f of files) {
    const body = readJson(path.join(dir, f));
    assert.ok(validate(body), `${f}: ${JSON.stringify(validate.errors)}`);
  }
  const sidecar = readJson(path.join(dir, files[0]));
  sidecar.source = 'sidecar';
  assert.equal(validate(sidecar), false, 'a posted body with source sidecar must be refused');
  const withSeq = readJson(path.join(dir, files[0]));
  withSeq.seq = 1;
  assert.equal(validate(withSeq), false, 'a posted body must not carry seq');
});

test('--write-posted leaves the committed posted schema unchanged', () => {
  const copy = path.join(mkdtempSync(path.join(os.tmpdir(), 'vm-e2e-events-')), 'events');
  temps.push(path.dirname(copy));
  cpSync(EVENTS, copy, { recursive: true });
  const file = 'instance-events.posted.schema.json';
  const lf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')); // a Windows checkout may hold CRLF
  const before = lf(readFileSync(path.join(copy, file)));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-events.mjs'), '--dir', copy, '--write-posted'], { encoding: 'utf8', env: cleanEnv, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Buffer.compare(before, lf(readFileSync(path.join(copy, file)))) === 0, 'regenerating the derived schema must not change it');
  assert.ok(Buffer.compare(lf(readFileSync(path.join(EVENTS, file))), lf(readFileSync(path.join(copy, file)))) === 0, 'and it equals the committed file');
});
