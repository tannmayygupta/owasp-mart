// The real injector (IF-6 section 5, handoff H-26): document rules, the exit codes, the order of the files, what is planted where, and the proof that matters: an
// instance made by the injector is exploitable by the very exploits that the challenge self-tests run, and only for the challenges whose flag was planted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runExploit } from '../../../../challenges/tests/runner/run-exploit.mjs';
import { readDocument as stubReadDocument } from '../../../../contracts/mocks/stub-instance/common.mjs';
import { createApp } from '../../src/app.mjs';
import { openDb } from '../../src/db/index.mjs';
import { documentProblems, EXIT, runInject } from '../../src/instance/inject.mjs';
import { makeInstanceChallenges } from '../../src/instance/instance.mjs';
import { readDocument } from '../../src/instance/read-document.mjs';
import { buildSnapshot } from '../../seed/build-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CH = path.resolve(HERE, '..', '..', '..', '..', 'challenges', 'tests');
const win = process.platform === 'win32';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2);
const flagN = (n) => `VM{${B32.slice(n, n + 24)}}`;
const KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];
const FLAGS = Object.fromEntries(KEYS.map((k, i) => [k, flagN(i)]));
const doc = (over = {}) => ({ schema_version: '0.1', instance_id: 'i-AAAAAAAAAAAAAAAA', epoch: 1, seed: 's'.repeat(40), flags: KEYS.map((k) => ({ challenge_key: k, flag: FLAGS[k] })), decoys: [], ...over });

let dir; let base;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'));
  base = path.join(dir, 'base.db');
  await buildSnapshot(base);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function layout(name) {
  const root = path.join(dir, name);
  const l = { root, vm: path.join(root, 'vm'), imp: path.join(root, 'import'), mock: path.join(root, 'mock') };
  for (const d of [l.vm, l.imp, l.mock]) fs.mkdirSync(d, { recursive: true });
  l.env = { VM_SNAPSHOT_PATH: path.join(l.vm, 'snapshot.db'), VM_FLAGS_PATH: path.join(l.vm, 'flags.json') };
  l.placements = [{ challenge_key: 'C06', dir: l.imp, file: 'C06.placement' }, { challenge_key: 'C10', dir: l.mock, file: 'C10.placement' }];
  return l;
}
const inject = (l, body, extra = {}) => { const lines = []; return runInject({ stdin: Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]), env: l.env, placements: l.placements, base, log: (m) => lines.push(m), ...extra }).then((code) => ({ code, lines })); };

test('a good document: exit 0, one fixed line, the files in the contract order and nothing but the flags file and the placements carries a flag', async () => {
  const l = layout('good');
  const { code, lines } = await inject(l, doc());
  assert.equal(code, EXIT.OK);
  assert.deepEqual(lines, ['inject: done']);
  assert.ok(!lines.join('').includes('VM{'));
  const marker = path.join(l.vm, 'injected');
  for (const f of [l.env.VM_SNAPSHOT_PATH, l.env.VM_FLAGS_PATH, marker]) assert.ok(fs.existsSync(f), f);
  assert.ok(fs.statSync(marker).mtimeMs >= fs.statSync(l.env.VM_FLAGS_PATH).mtimeMs, 'the marker is written last');
  assert.equal(fs.readFileSync(marker, 'utf8'), '');
  const flagsFile = JSON.parse(fs.readFileSync(l.env.VM_FLAGS_PATH, 'utf8'));
  assert.deepEqual([flagsFile.schema_version, flagsFile.instance_id, flagsFile.epoch], ['0.1', 'i-AAAAAAAAAAAAAAAA', 1]);
  assert.equal(fs.readFileSync(path.join(l.imp, 'C06.placement'), 'utf8'), FLAGS.C06);
  assert.equal(fs.readFileSync(path.join(l.mock, 'C10.placement'), 'utf8'), FLAGS.C10);
  assert.ok(!fs.existsSync(`${l.env.VM_SNAPSHOT_PATH}.tmp`) && !fs.existsSync(`${l.env.VM_SNAPSHOT_PATH}-wal`), 'no leftovers');
  if (!win) {
    assert.equal(fs.statSync(l.env.VM_FLAGS_PATH).mode & 0o777, 0o400);
    assert.equal(fs.statSync(marker).mode & 0o777, 0o444);
    assert.equal(fs.statSync(l.env.VM_SNAPSHOT_PATH).mode & 0o777, 0o444);
    assert.equal(fs.statSync(path.join(l.imp, 'C06.placement')).mode & 0o777, 0o400);
  }
});

test('the planted rows: each flag is in its place and only a challenge whose flag is in the document is planted', async () => {
  const l = layout('rows');
  assert.equal((await inject(l, doc())).code, 0);
  const db = openDb(l.env.VM_SNAPSHOT_PATH);
  try {
    const sentinel = Object.fromEntries(db.prepare('SELECT key, value FROM sentinel').all().map((r) => [r.key, r.value]));
    for (const k of ['C04', 'C05', 'C07', 'C08', 'C09', 'C11']) assert.equal(sentinel[k.toLowerCase()], FLAGS[k], k);
    assert.equal(db.prepare("SELECT buyer_note FROM orders WHERE order_no = 'VM-100777'").get().buyer_note, FLAGS.C01);
    assert.equal(db.prepare('SELECT message FROM gift_cards WHERE serial = 1').get().message, FLAGS.C02);
    assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id = 90001').get().total_cents, 2500);
  } finally { db.close(); }
  const some = layout('some');
  assert.equal((await inject(some, doc({ flags: [{ challenge_key: 'C05', flag: FLAGS.C05 }] }))).code, 0);
  const db2 = openDb(some.env.VM_SNAPSHOT_PATH);
  try {
    assert.deepEqual(db2.prepare('SELECT key FROM sentinel').all().map((r) => r.key), ['c05']);
    assert.equal(db2.prepare("SELECT COUNT(*) AS c FROM orders WHERE order_no = 'VM-100777'").get().c, 0);
  } finally { db2.close(); }
  assert.deepEqual(fs.readdirSync(some.imp), [], 'no C06 file when there is no C06 flag');
});

const bad = {
  'not JSON': '{"a":',
  'an array': '[]',
  'text': 'hello',
  'a byte order mark': `\uFEFF${JSON.stringify(doc())}`,
  'trailing data': `${JSON.stringify(doc())} x`,
  'an unknown field': doc({ extra: 1 }),
  'a missing seed': (() => { const d = doc(); delete d.seed; return d; })(),
  'a short seed': doc({ seed: 'short' }),
  'epoch zero': doc({ epoch: 0 }),
  'a float epoch': doc({ epoch: 1.5 }),
  'a bad instance id': doc({ instance_id: 'i-nope' }),
  'a flag of the wrong shape': doc({ flags: [{ challenge_key: 'C01', flag: 'VM{short}' }] }),
  'a challenge key outside C01 to C11': doc({ flags: [{ challenge_key: 'C12', flag: flagN(3) }] }),
  'the same challenge twice': doc({ flags: [{ challenge_key: 'C01', flag: flagN(1) }, { challenge_key: 'C01', flag: flagN(2) }] }),
  'the same flag twice': doc({ flags: [{ challenge_key: 'C01', flag: flagN(1) }, { challenge_key: 'C02', flag: flagN(1) }] }),
  'a decoy equal to a real flag': doc({ decoys: [{ challenge_key: 'C01', index: 0, value: FLAGS.C01 }] }),
  'a decoy for a challenge without a flag': doc({ flags: [{ challenge_key: 'C01', flag: flagN(1) }], decoys: [{ challenge_key: 'C02', index: 0, value: flagN(2) }] }),
  'no flags': doc({ flags: [] }),
};
for (const [name, body] of Object.entries(bad)) {
  test(`a bad document (${name}) stops at exit 10 and writes nothing`, async () => {
    const l = layout(`bad-${name.replace(/\W+/g, '-')}`);
    const { code, lines } = await inject(l, body);
    assert.equal(code, EXIT.BAD_DOCUMENT);
    assert.deepEqual(lines, ['inject: exit 10 (bad document)']);
    assert.deepEqual(fs.readdirSync(l.vm), [], 'no snapshot, no flags file, no marker');
  });
}

test('too large a document is refused (exit 10)', async () => {
  const l = layout('large');
  assert.equal((await inject(l, doc(), { maxBytes: 100 })).code, EXIT.BAD_DOCUMENT);
});

test('the failure exits: no baked snapshot is 11, an unwritable placement is 12, an unwritable flags file is 13, and no marker exists after any of them', async () => {
  const a = layout('exit11');
  assert.equal((await inject(a, doc(), { base: path.join(dir, 'missing.db') })).code, EXIT.SNAPSHOT);
  assert.ok(!fs.existsSync(path.join(a.vm, 'injected')));
  const b = layout('exit12');
  b.placements = [{ challenge_key: 'C06', dir: path.join(b.root, 'no-such-dir'), file: 'C06.placement' }];
  assert.equal((await inject(b, doc())).code, EXIT.PLACEMENT);
  assert.ok(!fs.existsSync(path.join(b.vm, 'injected')));
  const c = layout('exit13');
  fs.mkdirSync(c.env.VM_FLAGS_PATH); // a directory where the file must go
  assert.equal((await inject(c, doc())).code, EXIT.MARKER);
});

test('the document rules are the same as the contract check: documentProblems names JSON pointers and never a value', () => {
  assert.deepEqual(documentProblems(doc()), []);
  const probs = documentProblems(doc({ seed: 'x', flags: [{ challenge_key: 'C01', flag: 'VM{zzz}' }] }));
  assert.ok(probs.length > 0 && probs.every((p) => p.startsWith('/')) && !JSON.stringify(probs).includes('VM{'));
});

test('the stdin reader is the one of the stub injector: same answers on the same inputs', async () => {
  const cases = [JSON.stringify(doc()), '{"a":', '[]', 'x', '', `${JSON.stringify(doc())}\n`, `${JSON.stringify(doc())} tail`, `\uFEFF{}`, '{"s":"}{"}'];
  for (const c of cases) {
    const mine = await readDocument(Readable.from([c]), 65536);
    const theirs = await stubReadDocument(Readable.from([c]), 65536);
    assert.deepEqual(mine, theirs, JSON.stringify(c.slice(0, 20)));
  }
  assert.deepEqual(await readDocument(Readable.from(['{"a":"' + 'x'.repeat(200) + '"}']), 100), await stubReadDocument(Readable.from(['{"a":"' + 'x'.repeat(200) + '"}']), 100));
});

// ---- the shop made from an injected snapshot is exploitable, challenge by challenge ----
const EXPLOITS = [
  ['C01', 'c01-cross-store-order/exploit.mjs'], ['C02', 'c02-gift-card-codes/exploit.mjs'], ['C03', 'c03-injection/exploit-a-sqli.mjs'],
  ['C04', 'c04-quick-refund/exploit.mjs'], ['C05', 'c05-security-misconfig/exploit.mjs'], ['C07', 'c07-auth-failures/exploit.mjs'],
  ['C08', 'c08-payment-webhook/exploit.mjs'], ['C09', 'c09-logging-failures/exploit.mjs'], ['C11', 'c11-kyc-failopen/exploit.mjs'],
];

async function bootInstance(l, { env = {} } = {}) {
  const copy = path.join(l.root, `shop-${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(l.env.VM_SNAPSHOT_PATH, copy);
  fs.chmodSync(copy, 0o644);
  const db = openDb(copy);
  const inst = makeInstanceChallenges(l.env.VM_FLAGS_PATH);
  const events = [];
  const prev = process.env.VM_TEST;
  Object.assign(process.env, env);
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: inst.challenges, flagOf: inst.flagOf });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const restore = () => { if (prev === undefined) delete process.env.VM_TEST; else process.env.VM_TEST = prev; };
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events, restore };
}

for (const [key, file] of EXPLOITS) {
  test(`${key}: the exploit of the self-test passes against an instance made by the injector`, async () => {
    const l = layout(`exploit-${key}`);
    assert.equal((await inject(l, doc())).code, 0);
    const { default: exploit } = await import(pathToFileUrl(path.join(CH, file)));
    const shop = await bootInstance(l, key === 'C07' ? { env: { VM_TEST: '1' } } : {});
    try {
      const r = await runExploit({ baseUrl: shop.baseUrl, name: key, test: exploit });
      assert.equal(r.passed, true, `${key}: ${r.detail}`);
    } finally { shop.server.close(); shop.db.close(); shop.restore(); }
  });
}

test('without the marker, or without a flag for the challenge, the shop is the correct build: the same exploits fail', async () => {
  const l = layout('not-planted');
  assert.equal((await inject(l, doc({ flags: [{ challenge_key: 'C05', flag: FLAGS.C05 }] }))).code, 0);
  const { default: exploit } = await import(pathToFileUrl(path.join(CH, 'c01-cross-store-order/exploit.mjs')));
  const shop = await bootInstance(l);
  try {
    assert.equal((await runExploit({ baseUrl: shop.baseUrl, name: 'C01', test: exploit })).failed, true, 'C01 has no flag here: not exploitable');
  } finally { shop.server.close(); shop.db.close(); shop.restore(); }
  const none = makeInstanceChallenges(path.join(l.root, 'never-injected', 'flags.json'));
  assert.equal(none.challenges.C05, undefined);
  assert.equal(none.flagOf('C05'), undefined);
});

function pathToFileUrl(p) { return new URL(`file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`).href; }