// Admin API tests (contracts/edge/gate-ticket.md section 5): secret from a file, strict bodies, the epoch rule, sync, and constant-time hygiene.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdmin, MAX_BODY_BYTES } from '../src/admin.mjs';
import { ID_A, ID_B, ZONE, host, randomOwner, setup } from './helpers.mjs';

function rig() {
  const s = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-edge-admin-'));
  const secretFile = path.join(dir, 'admin-secret');
  const secret = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(secretFile, `${secret}\n`);
  const admin = createAdmin({ store: s.gate.store, secretFile });
  const call = (method, url, body, { auth = secret, headers = {} } = {}) => admin.handle({
    method, url, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { 'x-vm-gate-admin': auth }), ...headers },
  });
  const url = (id) => `/internal/v1/gate/instances/${id}`;
  return { ...s, admin, call, url, secret, secretFile, dir };
}
const snapshot = (store, ids) => JSON.stringify(ids.map((id) => store.get(id.toLowerCase())));

test('no secret, a wrong secret, a near-miss secret: 401 for every call and the state does not change', () => {
  const r = rig();
  const before = snapshot(r.gate.store, [ID_A, ID_B]);
  const body = r.record(ID_A, r.ownerA, { access: 'closed', access_epoch: 9 });
  const wrongs = [null, '', 'nope', r.secret.slice(0, -1), `${r.secret}x`, r.secret.toUpperCase(), ` ${r.secret}`];
  for (const auth of wrongs) {
    for (const [m, u, b] of [['PUT', r.url(ID_A), body], ['DELETE', r.url(ID_A)], ['PUT', '/internal/v1/gate/sync', { instances: [] }], ['GET', '/internal/v1/gate/nothing']]) {
      const out = r.call(m, u, b, { auth });
      assert.equal(out.status, 401, `${m} ${u} auth=${auth}`);
      assert.equal(out.headers['content-type'], 'application/problem+json');
    }
  }
  assert.equal(snapshot(r.gate.store, [ID_A, ID_B]), before);
  assert.equal(r.admin.handle({ method: 'PUT', url: r.url(ID_A), body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-vm-gate-admin': ['a', 'b'] } }).status, 401);
});

test('the secret is read from the file: a missing, empty or short file refuses every call; a rotated file takes effect', () => {
  const r = rig();
  const body = r.record(ID_A, r.ownerA, { access_epoch: 4 });
  assert.equal(r.call('PUT', r.url(ID_A), body).status, 204);
  const next = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(r.secretFile, next);
  assert.equal(r.call('PUT', r.url(ID_A), body).status, 401, 'the old secret stops working');
  assert.equal(r.call('PUT', r.url(ID_A), body, { auth: next }).status, 204);
  for (const content of ['', '   \n', 'short']) {
    fs.writeFileSync(r.secretFile, content);
    assert.equal(r.call('PUT', r.url(ID_A), body, { auth: content.trim() }).status, 401, `file ${JSON.stringify(content)}`);
  }
  fs.rmSync(r.secretFile);
  assert.equal(r.call('PUT', r.url(ID_A), body, { auth: next }).status, 401, 'file missing');
  assert.throws(() => createAdmin({ store: r.gate.store }));
  assert.throws(() => createAdmin({ secretFile: r.secretFile }));
});

test('PUT stores a record the gate then uses; DELETE makes the instance unknown (410)', () => {
  const r = rig();
  const id = 'i-ZZZZZZZZZZZZZZZZ';
  const owner = randomOwner();
  assert.equal(r.get('/', { id }).status, 410);
  const rec = r.record(id, owner);
  assert.equal(r.call('PUT', r.url(id), rec).status, 204);
  assert.equal(r.gate.store.get(id.toLowerCase()).owner, owner);
  const t = r.ticket({ inst: id, own: owner });
  assert.equal(r.get(`/_vm/enter?t=${t}`, { id }).status, 302);
  assert.equal(r.call('DELETE', r.url(id)).status, 204);
  assert.equal(r.call('DELETE', r.url(id)).status, 204, 'repeatable');
  assert.equal(r.get('/', { id }).status, 410);
});

test('strict bodies: unknown, missing and badly typed members are refused (422) and the state is unchanged', () => {
  const r = rig();
  const before = snapshot(r.gate.store, [ID_A]);
  const ok = r.record(ID_A, r.ownerA, { access_epoch: 5 });
  const bad = {
    'extra member': { ...ok, admin: true },
    'proto member': JSON.parse(`{"__proto__":{"x":1},"hostname":"${ok.hostname}","instance_id":"${ID_A}","epoch":1,"owner":"${ok.owner}","access":"open","access_epoch":5}`),
    'missing owner': (({ owner, ...x }) => x)(ok),
    'missing hostname': (({ hostname, ...x }) => x)(ok),
    'lower-case instance id': { ...ok, instance_id: ID_A.toLowerCase() },
    'hostname of another instance': { ...ok, hostname: host(ID_B) },
    'hostname in another zone': { ...ok, hostname: `${ID_A.toLowerCase()}.other.test` },
    'hostname upper case': { ...ok, hostname: host(ID_A).toUpperCase() },
    'hostname with port': { ...ok, hostname: `${host(ID_A)}:443` },
    'owner upper case': { ...ok, owner: ok.owner.toUpperCase() },
    'owner short': { ...ok, owner: ok.owner.slice(1) },
    'owner not a string': { ...ok, owner: 5 },
    'access unknown value': { ...ok, access: 'ajar' },
    'access upper case': { ...ok, access: 'OPEN' },
    'epoch zero': { ...ok, epoch: 0 },
    'epoch a string': { ...ok, epoch: '1' },
    'epoch a fraction': { ...ok, epoch: 1.5 },
    'access_epoch negative': { ...ok, access_epoch: -1 },
    'access_epoch a string': { ...ok, access_epoch: '5' },
    'access_epoch too big': { ...ok, access_epoch: 2 ** 60 },
    'access_epoch null': { ...ok, access_epoch: null },
    'array body': [ok],
    'null body': null,
    'string body': '"x"',
    'number body': 5,
  };
  for (const [name, body] of Object.entries(bad)) {
    const out = r.call('PUT', r.url(ID_A), typeof body === 'string' ? body : JSON.stringify(body));
    assert.equal(out.status, 422, name);
    assert.equal(JSON.parse(out.body).status, 422);
  }
  assert.equal(r.call('PUT', r.url(ID_A), { ...ok, instance_id: ID_B, hostname: host(ID_B) }).status, 422, 'body for another instance than the path');
  assert.equal(snapshot(r.gate.store, [ID_A]), before);
  assert.equal(r.call('PUT', r.url(ID_A), ok).status, 204, 'the good one still works');
});

test('transport rules: media type, size, JSON syntax, paths, methods', () => {
  const r = rig();
  const ok = r.record(ID_A, r.ownerA, { access_epoch: 5 });
  assert.equal(r.call('PUT', r.url(ID_A), ok, { headers: { 'content-type': 'text/plain' } }).status, 415);
  assert.equal(r.call('PUT', r.url(ID_A), ok, { headers: { 'content-type': 'application/json; charset=utf-8' } }).status, 204);
  assert.equal(r.admin.handle({ method: 'PUT', url: r.url(ID_A), body: JSON.stringify(ok), headers: { 'x-vm-gate-admin': r.secret } }).status, 415, 'no content type');
  assert.equal(r.call('PUT', r.url(ID_A), JSON.stringify({ ...ok, pad: 'x'.repeat(MAX_BODY_BYTES.instance) })).status, 413);
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', JSON.stringify({ instances: [], pad: 'x'.repeat(MAX_BODY_BYTES.sync) })).status, 413);
  assert.equal(r.call('PUT', r.url(ID_A), '{not json').status, 400);
  assert.equal(r.call('PUT', r.url(ID_A), '').status, 400);
  for (const u of ['/internal/v1/gate/instances/', '/internal/v1/gate/instances/i-short', `/internal/v1/gate/instances/${ID_A.toLowerCase()}`, `${r.url(ID_A)}/x`, `${r.url(ID_A)}?x=1`, '/internal/v1/gate/', '/internal/v1/gate/syncx', '/internal/v1/other', '/', '/internal/v1/gate/instances/../sync']) {
    assert.equal(r.call('PUT', u, ok).status, 404, u);
  }
  assert.equal(r.call('GET', r.url(ID_A)).status, 405);
  assert.equal(r.call('POST', r.url(ID_A), ok).status, 405);
  assert.equal(r.call('GET', '/internal/v1/gate/sync').status, 405);
  assert.equal(r.call('DELETE', '/internal/v1/gate/sync').status, 405);
});

test('epoch rule: lower access epoch, lower container epoch, equal epoch with another value: 409 and the old state remains', () => {
  const r = rig();
  const stored = JSON.stringify(r.gate.store.get(ID_A.toLowerCase()));
  const rec = (over) => r.record(ID_A, r.ownerA, over);
  for (const [name, body] of Object.entries({
    'lower access_epoch': rec({ access_epoch: 2 }),
    'lower access_epoch, other access': rec({ access_epoch: 0, access: 'closed' }),
    'equal access_epoch, other access': rec({ access: 'frozen' }),
    'equal access_epoch, other owner': r.record(ID_A, randomOwner()),
  })) {
    const out = r.call('PUT', r.url(ID_A), body);
    assert.equal(out.status, 409, name);
    assert.equal(out.headers['content-type'], 'application/problem+json');
    assert.equal(JSON.stringify(r.gate.store.get(ID_A.toLowerCase())), stored, `${name}: state unchanged`);
  }
  assert.equal(r.call('PUT', r.url(ID_A), rec({ epoch: 3, access_epoch: 4 })).status, 204);
  assert.equal(r.call('PUT', r.url(ID_A), rec({ epoch: 2, access_epoch: 9 })).status, 409, 'lower container epoch');
  assert.equal(r.gate.store.get(ID_A.toLowerCase()).access_epoch, 4);
  assert.equal(r.call('PUT', r.url(ID_A), rec({ epoch: 3, access_epoch: 4 })).status, 204, 'the same push again is accepted (idempotent)');
  assert.equal(r.call('PUT', r.url(ID_A), rec({ epoch: 3, access_epoch: 5, access: 'frozen' })).status, 204, 'a higher epoch may change anything');
  assert.equal(r.gate.store.get(ID_A.toLowerCase()).access, 'frozen');
});

test('sync: replaces the whole list, removes the rest, all or nothing', () => {
  const r = rig();
  const idC = 'i-AAAAAAAAAAAAAAAB';
  const ownerC = randomOwner();
  const list = { instances: [r.record(ID_A, r.ownerA, { access_epoch: 6 }), r.record(idC, ownerC, { access_epoch: 1 })] };
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', list).status, 204);
  assert.equal(r.gate.store.size, 2);
  assert.equal(r.gate.store.get(ID_B.toLowerCase()), undefined, 'B was not in the list: unknown, closed');
  assert.equal(r.get('/', { id: ID_B }).status, 410);
  assert.equal(r.gate.store.get(idC.toLowerCase()).owner, ownerC);

  const before = snapshot(r.gate.store, [ID_A, idC, ID_B]);
  const conflict = { instances: [r.record(idC, ownerC, { access_epoch: 2 }), r.record(ID_A, r.ownerA, { access_epoch: 1 })] };
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', conflict).status, 409);
  assert.equal(snapshot(r.gate.store, [ID_A, idC, ID_B]), before, 'one conflict refuses the whole sync');
  const invalid = { instances: [r.record(idC, ownerC, { access_epoch: 2 }), { nonsense: true }] };
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', invalid).status, 422);
  assert.equal(snapshot(r.gate.store, [ID_A, idC, ID_B]), before);
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', { instances: [r.record(idC, ownerC), r.record(idC, ownerC)] }).status, 422, 'listed twice');
  for (const body of [{}, { instances: 'x' }, { instances: [], extra: 1 }, [], null, { instance: [] }]) assert.equal(r.call('PUT', '/internal/v1/gate/sync', JSON.stringify(body)).status, 422, JSON.stringify(body));
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', { instances: new Array(2001).fill(0).map(() => r.record(idC, ownerC)) }).status, 422, 'too many');
  assert.equal(snapshot(r.gate.store, [ID_A, idC, ID_B]), before);
  assert.equal(r.call('PUT', '/internal/v1/gate/sync', { instances: [] }).status, 204);
  assert.equal(r.gate.store.size, 0, 'an empty list closes everything');
  assert.equal(r.get('/', { id: ID_A }).status, 410);
});

test('the answers carry no secret and no stored value', () => {
  const r = rig();
  const outs = [r.call('PUT', r.url(ID_A), { nope: 1 }), r.call('PUT', r.url(ID_A), r.record(ID_A, r.ownerA, { access_epoch: 0 })), r.call('GET', '/x', undefined, { auth: null })];
  for (const o of outs) {
    const text = JSON.stringify(o);
    assert.ok(!text.includes(r.secret) && !text.includes(r.ownerA), 'no secret or owner hash in an answer');
  }
});

test('constant-time hygiene: signatures, keys and secrets are compared with timingSafeEqual, never with ===', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = ['tickets.mjs', 'gate.mjs', 'admin.mjs'];
  const bad = /\b(?:sig|signature|secret|expected|given|mac|payloadB64|token|value)\s*[!=]==(?!\s*['"\d]|\s*undefined|\s*null)|(?:claims|rec)\.(?:inst|own|owner|ae|instance_id|access_epoch)\s*[!=]==|[!=]==\s*(?:claims|rec)\.(?:inst|own|owner|ae|instance_id|access_epoch)/;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      assert.ok(!bad.test(code), `${f}:${i + 1} compares a secret with ===: ${line.trim()}`);
    });
  }
  assert.match(fs.readFileSync(path.join(dir, 'tickets.mjs'), 'utf8'), /crypto\.timingSafeEqual/);
  assert.match(fs.readFileSync(path.join(dir, 'admin.mjs'), 'utf8'), /safeEqual\(given, expected\)/);
  assert.match(fs.readFileSync(path.join(dir, 'gate.mjs'), 'utf8'), /safeEqual\(claims\.own, rec\.owner\)/);
});

test('safeEqual: equal, different, different length, non-strings', async () => {
  const { safeEqual } = await import('../src/tickets.mjs');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(1, 1), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(ZONE, 'labs.test');
});
