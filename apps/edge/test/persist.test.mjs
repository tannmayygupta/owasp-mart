// Durable state of the gate (persist.mjs, ADR 0058): a restart keeps the access map and the used tickets, and a state that is old, forged or malformed is ignored.
// The restart tests start the real service (server.mjs) twice on the same state file, with a fake sidecar standing in for the instance. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGate } from '../src/gate.mjs';
import { createPersistence, createSaver } from '../src/persist.mjs';
import { startServer } from '../src/server.mjs';
import { newJti, signTicket } from '../src/tickets.mjs';
import { host, ID_A, ID_B, NOW_MS, randomKey, randomOwner, ZONE } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vm-edge-persist-'));
const record = (id, owner, over = {}) => ({ hostname: host(id), instance_id: id, epoch: 1, owner, access: 'open', access_epoch: 3, ...over });
const JTI = () => newJti();

// ---------- the file ----------

test('save and load round trip: records and unexpired ticket ids come back, expired ids do not', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  const keys = { current: randomKey() };
  let now = NOW_MS;
  const p = createPersistence({ file, keys, zone: ZONE, now: () => now });
  const a = record(ID_A, randomOwner());
  const live = JTI();
  const dead = JTI();
  assert.equal(p.save({ instances: [a], used: [[live, Math.floor(NOW_MS / 1000) + 100], [dead, Math.floor(NOW_MS / 1000) + 5]] }), true);
  now += 10_000;
  const got = p.load();
  assert.deepEqual(got.instances, [a]);
  assert.deepEqual(got.used.map((u) => u[0]), [live], 'the ticket id that expired in the meantime is not kept');
  assert.equal(p.lastLoad().status, 'restored');
  fs.rmSync(dir, { recursive: true });
});

test('the file is private (mode 0600 where the platform has modes), written atomically, and no temp file is left', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'state.json');
  const p = createPersistence({ file, keys: { current: randomKey() }, zone: ZONE, now: () => NOW_MS });
  assert.equal(p.save({ instances: [], used: [] }), true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});

test('no file: nothing is restored and nothing is reported as a problem', () => {
  const logs = [];
  const p = createPersistence({ file: path.join(tmp(), 'none.json'), keys: { current: randomKey() }, zone: ZONE, log: (m) => logs.push(m) });
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'no saved state');
  assert.deepEqual(logs, []);
});

test('a state older than the maximum age is ignored (the orchestrator may have closed instances meanwhile): the gate starts closed', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  const keys = { current: randomKey() };
  let now = NOW_MS;
  const p = createPersistence({ file, keys, zone: ZONE, now: () => now, maxAgeS: 600 });
  p.save({ instances: [record(ID_A, randomOwner())], used: [] });
  now += 599_000;
  assert.equal(p.load().instances.length, 1);
  now += 2_000;
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'stale');
  fs.rmSync(dir, { recursive: true });
});

test('a changed or foreign file is refused: edited payload, signature of another key, not JSON, wrong version', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  const keys = { current: randomKey() };
  const logs = [];
  const p = createPersistence({ file, keys, zone: ZONE, now: () => NOW_MS, log: (m) => logs.push(m) });
  p.save({ instances: [record(ID_A, randomOwner())], used: [] });
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  // an attacker who can write the volume opens another instance
  const body = JSON.parse(env.payload);
  body.instances.push(record(ID_B, randomOwner()));
  fs.writeFileSync(file, JSON.stringify({ ...env, payload: JSON.stringify(body) }));
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'forged');
  // a file made with another key
  createPersistence({ file, keys: { current: randomKey() }, zone: ZONE, now: () => NOW_MS }).save({ instances: [], used: [] });
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'forged');
  fs.writeFileSync(file, 'not json');
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'corrupt');
  fs.writeFileSync(file, JSON.stringify({ v: 99, mac: '00', payload: '{}' }));
  assert.equal(p.load(), null);
  assert.equal(p.lastLoad().status, 'corrupt');
  assert.ok(logs.length >= 4 && logs.every((m) => !m.includes(ID_A) && !m.includes('payload')), 'every refusal is logged, with no value in it');
  fs.rmSync(dir, { recursive: true });
});

test('a key rotation does not lose the state: a file signed with the previous key still loads, and the next save uses the current key', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  const oldKey = randomKey();
  const newKey = randomKey();
  createPersistence({ file, keys: { current: oldKey }, zone: ZONE, now: () => NOW_MS }).save({ instances: [record(ID_A, randomOwner())], used: [] });
  const rotated = createPersistence({ file, keys: { current: newKey, previous: oldKey }, zone: ZONE, now: () => NOW_MS });
  assert.equal(rotated.load().instances.length, 1);
  rotated.save({ instances: [], used: [] });
  assert.equal(createPersistence({ file, keys: { current: newKey }, zone: ZONE, now: () => NOW_MS }).load().instances.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('one bad record or ticket id ends the whole load (all or nothing)', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  const keys = { current: randomKey() };
  const p = createPersistence({ file, keys, zone: ZONE, now: () => NOW_MS });
  p.save({ instances: [record(ID_A, randomOwner()), record(ID_B, 'not-hex')], used: [] });
  assert.equal(p.load(), null);
  p.save({ instances: [record(ID_A, randomOwner())], used: [['not a ticket id', Math.floor(NOW_MS / 1000) + 50]] });
  assert.equal(p.load(), null);
  p.save({ instances: [record(ID_A, randomOwner()), record(ID_A, randomOwner())], used: [] });
  assert.equal(p.load(), null, 'the same instance twice');
  fs.rmSync(dir, { recursive: true });
});

test('a failing write is counted and logged and never thrown into a request', () => {
  const logs = [];
  const bad = { ...fs, openSync() { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } };
  const p = createPersistence({ file: path.join(tmp(), 's.json'), keys: { current: randomKey() }, zone: ZONE, log: (m) => logs.push(m), fsImpl: bad });
  assert.equal(p.save({ instances: [], used: [] }), false);
  assert.equal(p.saveErrors(), 1);
  assert.match(logs[0], /ENOSPC/);
});

test('the saver writes once for a burst of changes, writes the latest state, and flushes on stop', () => {
  const saves = [];
  const timers = [];
  let state = { instances: [1], used: [] };
  const saver = createSaver({
    persistence: { save: (s) => { saves.push(JSON.stringify(s)); return true; } }, snapshot: () => state,
    setTimer: (fn) => { const t = { fn, unref() {} }; timers.push(t); return t; }, clearTimer: () => {}, setTick: () => ({ unref() {} }), clearTick: () => {},
  });
  saver.schedule(); saver.schedule(); saver.schedule();
  assert.equal(timers.length, 1, 'one timer for a burst');
  state = { instances: [1, 2], used: [] };
  timers[0].fn();
  assert.deepEqual(saves, [JSON.stringify({ instances: [1, 2], used: [] })]);
  state = { instances: [3], used: [] };
  saver.stop();
  assert.equal(saves.at(-1), JSON.stringify({ instances: [3], used: [] }));
});

// ---------- the gate: used tickets and errors ----------

test('restoreUsed: a ticket id that was used before the restart is refused again, and the restore never shortens an entry', () => {
  const keys = { current: randomKey() };
  const owner = randomOwner();
  const clock = { ms: NOW_MS };
  const changes = [];
  const g1 = createGate({ keys, zone: ZONE, now: () => clock.ms, onUsedChange: () => changes.push(1) });
  g1.store.put(ID_A, record(ID_A, owner));
  const jti = JTI();
  const t = signTicket(keys, { inst: ID_A, own: owner, ae: 3, exp: Math.floor(NOW_MS / 1000) + 30, jti });
  const enter = (g) => g.decide({ method: 'GET', url: `/_vm/enter?t=${t}`, headers: { host: host(ID_A) } });
  assert.equal(enter(g1).status, 302);
  assert.equal(changes.length, 1, 'a used ticket asks the saver to save');
  const saved = g1.usedSnapshot();
  const g2 = createGate({ keys, zone: ZONE, now: () => clock.ms });
  g2.store.put(ID_A, record(ID_A, owner));
  g2.restoreUsed(saved);
  assert.equal(enter(g2).status, 403, 'replay after the restart is refused');
  clock.ms += 60_000;
  g2.restoreUsed([[jti, 1]]);
  assert.equal(g2.usedTickets(), 1, 'an entry that already expired is not restored');
});

test('decide: an exception is refused (fail closed) but counted, logged by class name only, and shown by status()', () => {
  const logs = [];
  const g = createGate({ keys: { current: randomKey() }, zone: ZONE, log: (m) => logs.push(m) });
  g.store.put(ID_A, record(ID_A, randomOwner()));
  const boom = { method: 'GET', url: '/', headers: { get host() { throw new TypeError('secret-ticket-value'); } } };
  const r = g.decide(boom);
  assert.equal(r.status, 403);
  assert.equal(g.errors(), 1);
  assert.equal(g.status().decide_errors, 1);
  assert.match(logs[0], /decide failed \(TypeError\); 1 so far/);
  assert.ok(!logs.join('\n').includes('secret-ticket-value'), 'the text of the error is not logged');
  // an ordinary refusal is not an error
  g.decide({ method: 'GET', url: '/', headers: { host: host(ID_A) } });
  assert.equal(g.errors(), 1);
});

// ---------- the service: a real restart ----------

const req = (port, { method = 'GET', p = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});

async function withService(fn) {
  const dir = tmp();
  const secretFile = path.join(dir, 'admin');
  const SECRET = randomKey().toString('hex');
  fs.writeFileSync(secretFile, `${SECRET}\n`);
  const keys = { current: randomKey() };
  const sidecar = http.createServer((rq, rs) => { rs.writeHead(200, { 'content-type': 'text/plain' }); rs.end('shop-a'); });
  await new Promise((r) => sidecar.listen(0, '127.0.0.1', r));
  const stateFile = path.join(dir, 'state', 'edge-state.json');
  const logs = [];
  const start = (extra = {}) => startServer({
    zone: ZONE, keys, adminSecretFile: secretFile, ingestUrl: 'http://127.0.0.1:9', playerHost: '127.0.0.1', adminHost: '127.0.0.1', relayHost: '127.0.0.1',
    playerPort: 0, adminPort: 0, relayPort: 0, stateFile, saveDelayMs: 5, log: (m) => logs.push(m),
    resolveUpstream: () => ({ hostname: '127.0.0.1', port: sidecar.address().port }), ...extra,
  });
  const admin = (srv, method, p, body) => req(srv.ports.admin, { method, p, headers: { 'content-type': 'application/json', 'x-vm-gate-admin': SECRET }, body: body ? JSON.stringify(body) : undefined });
  try {
    await fn({ start, admin, keys, stateFile, logs, dir });
  } finally {
    sidecar.closeAllConnections(); sidecar.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('restart: a live lab still answers after the edge restarts, with the same cookie, and the used ticket stays used', async () => {
  await withService(async ({ start, admin, keys, stateFile }) => {
    const owner = randomOwner();
    let srv = await start();
    assert.equal((await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, owner))).status, 204);
    const t = signTicket(keys, { inst: ID_A, own: owner, ae: 3, exp: Math.floor(Date.now() / 1000) + 30, jti: JTI() });
    const enter = await req(srv.ports.player, { p: `/_vm/enter?t=${t}`, headers: { host: host(ID_A) } });
    assert.equal(enter.status, 302);
    const cookie = enter.headers['set-cookie'][0].split(';')[0];
    assert.equal((await req(srv.ports.player, { p: '/x', headers: { host: host(ID_A), cookie } })).text, 'shop-a');
    await srv.stop(); // the edge goes down (SIGTERM flushes)
    assert.ok(fs.existsSync(stateFile));
    srv = await start(); // and comes back with an empty memory
    assert.equal((await srv.status()).saved_state.status, 'restored');
    const after = await req(srv.ports.player, { p: '/x', headers: { host: host(ID_A), cookie } });
    assert.equal(after.status, 200, 'the lab is not "ended" after the restart');
    assert.equal(after.text, 'shop-a');
    const replay = await req(srv.ports.player, { p: `/_vm/enter?t=${t}`, headers: { host: host(ID_A) } });
    assert.equal(replay.status, 403, 'a ticket used before the restart is refused after it');
    // the orchestrator is still the writer of truth: closing the instance after the restart works
    assert.equal((await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, owner, { access: 'closed', access_epoch: 4 }))).status, 204);
    assert.equal((await req(srv.ports.player, { p: '/x', headers: { host: host(ID_A), cookie } })).status, 410);
    // and a push with an older epoch than the restored one is still refused by the epoch rule
    assert.equal((await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_B}`, record(ID_B, owner, { access_epoch: 5 }))).status, 204);
    assert.equal((await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_B}`, record(ID_B, owner, { access_epoch: 4 }))).status, 409);
    await srv.stop();
  });
});

test('a crash (no flush at stop) loses at most the last moments: the debounced save has already written a change', async () => {
  await withService(async ({ start, admin, stateFile }) => {
    const owner = randomOwner();
    const srv = await start();
    await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, owner));
    await new Promise((r) => setTimeout(r, 80)); // the debounce (5 ms in this test) has fired
    const copy = `${stateFile}.crash`;
    fs.copyFileSync(stateFile, copy); // what a killed process leaves behind
    await srv.stop();
    fs.copyFileSync(copy, stateFile);
    const again = await start();
    assert.equal(again.status().instances, 1);
    await again.stop();
  });
});

test('a forged or stale state file does not open anything: the gate starts closed and says why', async () => {
  await withService(async ({ start, admin, stateFile, logs }) => {
    const owner = randomOwner();
    let srv = await start();
    await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, owner));
    await srv.stop();
    const env = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...env, payload: env.payload.replace('"open"', '"open" ') }));
    srv = await start();
    assert.equal(srv.status().instances, 0);
    assert.equal(srv.status().saved_state.status, 'forged');
    assert.ok(logs.some((m) => /saved state ignored \(forged/.test(m)));
    assert.equal((await req(srv.ports.player, { p: '/x', headers: { host: host(ID_A) } })).status, 410);
    await srv.stop();
    // a stale one
    srv = await start({ stateMaxAgeS: 1 });
    await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, owner));
    await srv.stop();
    await new Promise((r) => setTimeout(r, 2200));
    srv = await start({ stateMaxAgeS: 1 });
    assert.equal(srv.status().instances, 0);
    assert.equal(srv.status().saved_state.status, 'stale');
    await srv.stop();
  });
});

test('the admin status call shows counts only and needs the secret', async () => {
  await withService(async ({ start, admin }) => {
    const srv = await start();
    await admin(srv, 'PUT', `/internal/v1/gate/instances/${ID_A}`, record(ID_A, randomOwner()));
    const ok = await admin(srv, 'GET', '/internal/v1/gate/status');
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.text);
    assert.equal(body.instances, 1);
    assert.equal(body.decide_errors, 0);
    assert.equal(body.saved_state.enabled, true);
    assert.ok(!ok.text.includes(ID_A), 'no instance id in the status');
    assert.equal((await req(srv.ports.admin, { p: '/internal/v1/gate/status' })).status, 401);
    assert.equal((await admin(srv, 'POST', '/internal/v1/gate/status')).status, 405);
    await srv.stop();
  });
});

test('without EDGE_STATE_FILE the service behaves as before: memory only, no file', async () => {
  const dir = tmp();
  const secretFile = path.join(dir, 'admin');
  fs.writeFileSync(secretFile, `${randomKey().toString('hex')}\n`);
  const srv = await startServer({ zone: ZONE, keys: { current: randomKey() }, adminSecretFile: secretFile, ingestUrl: 'http://127.0.0.1:9', playerHost: '127.0.0.1', adminHost: '127.0.0.1', relayHost: '127.0.0.1', playerPort: 0, adminPort: 0, relayPort: 0 });
  assert.deepEqual(srv.status().saved_state, { enabled: false });
  await srv.stop();
  assert.deepEqual(fs.readdirSync(dir), ['admin']);
  fs.rmSync(dir, { recursive: true });
});
