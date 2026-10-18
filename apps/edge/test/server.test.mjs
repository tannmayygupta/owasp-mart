// Tests of the gate service wiring (server.mjs): the three listeners on 127.0.0.1 with a fake sidecar standing in for the instance. No Docker.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { newJti, signTicket } from '../src/tickets.mjs';
import { readKeyFile, resolveBindHost, startServer } from '../src/server.mjs';
import { host, ID_A, ID_B, randomKey, randomOwner, ZONE } from './helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-edge-unit-'));
const secretFile = path.join(dir, 'admin');
const SECRET = randomKey().toString('hex');
const keys = { current: randomKey() };
const ownerA = randomOwner();
let sidecar; let sidecarSeen; let srv; let ingest;
const ingestSeen = [];

const req = (port, { method = 'GET', p = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});
const push = (id, rec) => req(srv.ports.admin, { method: 'PUT', p: `/internal/v1/gate/instances/${id}`, headers: { 'content-type': 'application/json', 'x-vm-gate-admin': SECRET }, body: JSON.stringify(rec) });
const record = (id, owner, over = {}) => ({ hostname: host(id), instance_id: id, epoch: 1, owner, access: 'open', access_epoch: 1, ...over });
const ticket = (id, owner, ae = 1) => signTicket(keys, { inst: id, own: owner, ae, exp: Math.floor(Date.now() / 1000) + 30, jti: newJti() });

before(async () => {
  fs.writeFileSync(secretFile, `${SECRET}\n`);
  sidecarSeen = [];
  sidecar = http.createServer((rq, rs) => {
    sidecarSeen.push({ url: rq.url, cookie: rq.headers.cookie, host: rq.headers.host, vm: Object.keys(rq.headers).filter((k) => k.startsWith('x-vm-')) });
    rs.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'shop=1; Path=/' });
    rs.end('shop-a');
  });
  await new Promise((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  ingest = http.createServer((rq, rs) => { ingestSeen.push(rq.url); rq.resume(); rs.writeHead(202, { 'content-type': 'application/json' }); rs.end('{}'); });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  srv = await startServer({
    zone: ZONE, keys, adminSecretFile: secretFile, ingestUrl: `http://127.0.0.1:${ingest.address().port}`,
    playerHost: '127.0.0.1', adminHost: '127.0.0.1', relayHost: '127.0.0.1', playerPort: 0, adminPort: 0, relayPort: 0,
    resolveUpstream: (name) => { assert.match(name, /^vm-i-[a-z2-7]{16}-e1-sidecar$/); return { hostname: '127.0.0.1', port: sidecar.address().port }; },
  });
});
after(async () => {
  await srv.stop();
  for (const s of [sidecar, ingest]) { s.closeAllConnections(); s.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin push, ticket exchange, cookie, proxy: the owner reaches the shop and the gate cookie is not passed on', async () => {
  assert.equal((await push(ID_A, record(ID_A, ownerA))).status, 204);
  const enter = await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_A, ownerA)}`, headers: { host: host(ID_A) } });
  assert.equal(enter.status, 302);
  const cookie = enter.headers['set-cookie'][0].split(';')[0];
  const page = await req(srv.ports.player, { p: '/products?q=1', headers: { host: host(ID_A), cookie: `${cookie}; theme=dark` } });
  assert.equal(page.status, 200);
  assert.equal(page.text, 'shop-a');
  assert.deepEqual(page.headers['set-cookie'], ['shop=1; Path=/']);
  const last = sidecarSeen.at(-1);
  assert.equal(last.url, '/products?q=1');
  assert.equal(last.cookie, 'theme=dark');
  assert.equal(last.host, host(ID_A));
});

test('a client header of the x-vm-* family never reaches the sidecar (review finding C10)', async () => {
  assert.equal((await push(ID_A, record(ID_A, ownerA))).status, 204);
  const enter = await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_A, ownerA)}`, headers: { host: host(ID_A) } });
  const cookie = enter.headers['set-cookie'][0].split(';')[0];
  const page = await req(srv.ports.player, { p: '/x', headers: { host: host(ID_A), cookie, 'x-vm-session-kind': 'bot', 'X-VM-Instance': 'other', 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(page.status, 200);
  assert.deepEqual(sidecarSeen.at(-1).vm, []);
});

test('refusals do not touch the sidecar: no cookie, other owner, other host, replayed ticket, bad host', async () => {
  const before = sidecarSeen.length;
  assert.equal((await push(ID_B, record(ID_B, randomOwner()))).status, 204);
  assert.equal((await req(srv.ports.player, { headers: { host: host(ID_A) } })).status, 403);
  assert.equal((await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_A, randomOwner())}`, headers: { host: host(ID_A) } })).status, 403);
  const t = ticket(ID_A, ownerA);
  assert.equal((await req(srv.ports.player, { p: `/_vm/enter?t=${t}`, headers: { host: host(ID_A) } })).status, 302);
  assert.equal((await req(srv.ports.player, { p: `/_vm/enter?t=${t}`, headers: { host: host(ID_A) } })).status, 403);
  const cookieA = (await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_A, ownerA)}`, headers: { host: host(ID_A) } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(srv.ports.player, { headers: { host: host(ID_B), cookie: cookieA } })).status, 403);
  for (const h of ['localhost', '127.0.0.1', `${host(ID_A)}:443`, host(ID_A).toUpperCase(), 'i-aaaaaaaaaaaaaaaa.other.test']) {
    assert.equal((await req(srv.ports.player, { headers: { host: h, cookie: cookieA } })).status, 410, h);
  }
  assert.equal(sidecarSeen.length, before);
});

test('frozen is 423 and closed is 410 at once, and the sidecar is not touched', async () => {
  const ownerC = randomOwner();
  const ID_C = 'i-CCCCCCCCCCCCCCCC';
  await push(ID_C, record(ID_C, ownerC));
  const cookie = (await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_C, ownerC)}`, headers: { host: host(ID_C) } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(srv.ports.player, { headers: { host: host(ID_C), cookie } })).status, 200);
  const n = sidecarSeen.length;
  assert.equal((await push(ID_C, record(ID_C, ownerC, { access: 'frozen', access_epoch: 2 }))).status, 204);
  assert.equal((await req(srv.ports.player, { headers: { host: host(ID_C), cookie } })).status, 423);
  assert.equal((await push(ID_C, record(ID_C, ownerC, { access: 'closed', access_epoch: 3 }))).status, 204);
  assert.equal((await req(srv.ports.player, { headers: { host: host(ID_C), cookie } })).status, 410);
  assert.equal(sidecarSeen.length, n);
});

test('the admin listener refuses a call without the secret and a wrong content type', async () => {
  assert.equal((await req(srv.ports.admin, { method: 'PUT', p: `/internal/v1/gate/instances/${ID_A}`, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await req(srv.ports.admin, { method: 'PUT', p: '/internal/v1/gate/sync', headers: { 'x-vm-gate-admin': SECRET, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await req(srv.ports.player, { method: 'PUT', p: `/internal/v1/gate/instances/${ID_A}`, headers: { host: host(ID_A), 'x-vm-gate-admin': SECRET, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'the admin path is not served on the player listener');
});

test('the relay listener forwards one event and nothing else', async () => {
  ingestSeen.length = 0;
  const sig = { 'content-type': 'application/json', 'x-vm-signature': `v1=${'b'.repeat(64)}` };
  assert.equal((await req(srv.ports.relay, { method: 'POST', p: '/internal/v1/events', headers: sig, body: '{"a":1}' })).status, 202);
  assert.equal((await req(srv.ports.relay, { method: 'POST', p: '/internal/v1/events', headers: sig, body: '[{"a":1},{"a":2}]' })).status, 422);
  assert.equal((await req(srv.ports.relay, { p: '/_fake/events' })).status, 404);
  assert.equal(ingestSeen.length, 1);
});

test('a sidecar that is down gives a 502 page, not a hang', async () => {
  const ownerD = randomOwner();
  const ID_D = 'i-DDDDDDDDDDDDDDDD';
  await push(ID_D, record(ID_D, ownerD));
  const cookie = (await req(srv.ports.player, { p: `/_vm/enter?t=${ticket(ID_D, ownerD)}`, headers: { host: host(ID_D) } })).headers['set-cookie'][0].split(';')[0];
  const s2 = await startServer({ zone: ZONE, keys, adminSecretFile: secretFile, ingestUrl: 'http://127.0.0.1:9', playerHost: '127.0.0.1', playerPort: 0, adminPort: 0, relayPort: 0, relayHost: '127.0.0.1', resolveUpstream: () => ({ hostname: '127.0.0.1', port: 9 }) });
  try {
    const rec = record(ID_D, ownerD);
    await req(s2.ports.admin, { method: 'PUT', p: `/internal/v1/gate/instances/${ID_D}`, headers: { 'content-type': 'application/json', 'x-vm-gate-admin': SECRET }, body: JSON.stringify(rec) });
    assert.equal((await req(s2.ports.player, { headers: { host: host(ID_D), cookie } })).status, 502);
  } finally { await s2.stop(); }
});

test('key files: hex of at least 64 characters; the previous key may be missing, a folder or empty; a bad current key ends the start', () => {
  const good = path.join(dir, 'k-good');
  fs.writeFileSync(good, `${randomKey().toString('hex')}\n`);
  assert.equal(readKeyFile(good).length, 32);
  const short = path.join(dir, 'k-short');
  fs.writeFileSync(short, 'abcd');
  assert.throws(() => readKeyFile(short), /at least 64 hex/);
  const text = path.join(dir, 'k-text');
  fs.writeFileSync(text, 'z'.repeat(64));
  assert.throws(() => readKeyFile(text), /hex/);
  assert.throws(() => readKeyFile(path.join(dir, 'nope')), /cannot read/);
  assert.equal(readKeyFile(path.join(dir, 'nope'), { optional: true }), undefined);
  assert.equal(readKeyFile(dir, { optional: true }), undefined);
  const empty = path.join(dir, 'k-empty');
  fs.writeFileSync(empty, '\n');
  assert.equal(readKeyFile(empty, { optional: true }), undefined);
});

test('bind host: an address is used as is; a name that does not resolve fails after the tries', async () => {
  assert.equal(await resolveBindHost('10.1.2.3'), '10.1.2.3');
  await assert.rejects(resolveBindHost('no-such-name.invalid', { tries: 2, waitMs: 10 }), /cannot resolve the bind name/);
});
