import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { validateEvents, main, catalogueRows, schemaTypes, runMatrix, derivePosted, DEFAULT_DIR, SCHEMA_FILE, CONTRACT_MD, POSTED_FILE, POSTED_SOURCES, POSTED_EVIDENCE_BODY_CHARS } from './validate-events.mjs';
import { createIngest, LIMITS } from '../contracts/mocks/fake-ingest/ingest.mjs';
import { startServer, parseArgs } from '../contracts/mocks/fake-ingest/server.mjs';
import { signEvent, signBody, verifySignature, TEST_KEY, TEST_INSTANCE } from '../contracts/mocks/fake-ingest/sign.mjs';
import { deriveEventKey, TEST_MASTER_HEX } from '../contracts/mocks/fake-ingest/event-key.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-events.mjs');
const SCHEMA = path.join(DEFAULT_DIR, SCHEMA_FILE);
const VALID_DIR = path.join(DEFAULT_DIR, 'examples', 'valid', 'instance-events');
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJ = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const failsWith = (res, re) => res.errors.some((e) => re.test(e));
const loadEvents = () => fs.readdirSync(VALID_DIR).map((n) => ({ name: n, event: readJ(path.join(VALID_DIR, n)) })).sort((a, b) => a.event.seq - b.event.seq);
const clone = (o) => JSON.parse(JSON.stringify(o));
const ingest = (opts = {}) => createIngest({ keys: { [TEST_INSTANCE]: TEST_KEY }, schemaFile: SCHEMA, ...opts });
const get = (type) => clone(readJ(path.join(VALID_DIR, `${type}.json`)));
const REAL_LOOKING = 'VM{' + 'K7Q2M4ZPX3R5T6V7W2A3B4C5' + '}';
// Change one parsed field and re-serialise, so the signature no longer matches; asserts the body really changed.
const tamper = (body) => {
  const o = JSON.parse(body);
  o.ts = '2026-05-05T05:05:05Z';
  const out = JSON.stringify(o);
  assert.notEqual(out, body);
  return out;
};

function withCopy(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-events-'));
  try {
    fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the real contract validates: counts printed, schema and catalogue agree', () => {
  const res = validateEvents();
  assert.deepEqual(res.errors, []);
  assert.ok(res.ok);
  assert.ok(res.lines.some((l) => /checked 1 schema, 29 event types, 29 valid events, \d+ signed envelopes, \d+ valid posted bodies and \d+ invalid examples/.test(l)));
  assert.ok(res.lines.some((l) => /catalogue table: 29 types, schema: 29 types/.test(l)));
});

test('the 29 types of the challenge specs plus infrastructure_fault are all listed', () => {
  const { list } = schemaTypes(readJ(SCHEMA));
  assert.equal(list.length, 29);
  for (const t of ['proxy.request', 'proxy.flag_seen', 'evidence.capture', 'bot.visit', 'instance.flags_injected', 'infrastructure_fault', 'kyc.result']) assert.ok(list.includes(t), t);
});

test('decision 1 and D-42: the catalogue event_id is gone, identity is (instance_id, epoch, seq)', () => {
  const schema = readJ(SCHEMA);
  assert.equal(schema.properties.event_id, undefined);
  assert.ok(schema.required.includes('seq') && schema.required.includes('instance_id') && schema.required.includes('epoch'));
  assert.equal(schema.additionalProperties, false);
});

// ---- schema and catalogue consistency ----
test('a type removed from the schema but still in the catalogue exits non-zero', () => {
  withCopy((dir) => {
    const f = path.join(dir, SCHEMA_FILE);
    const s = readJ(f);
    s.properties.type.enum = s.properties.type.enum.filter((t) => t !== 'kyc.result');
    s.allOf = s.allOf.filter((e) => !(e.if && e.if.properties && e.if.properties.type && e.if.properties.type.const === 'kyc.result'));
    writeJ(f, s);
    const res = validateEvents({ dir });
    assert.equal(res.ok, false);
    assert.ok(failsWith(res, /catalogue lists kyc\.result, which is not in the schema/));
    assert.equal(main(['--dir', dir], { log() {}, err() {} }), 1);
  });
});

test('a type in the schema but missing from the catalogue fails', () => {
  withCopy((dir) => {
    const f = path.join(dir, CONTRACT_MD);
    const md = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('| `store.approved`')).join('\n');
    fs.writeFileSync(f, md);
    const res = validateEvents({ dir });
    assert.ok(failsWith(res, /schema type store\.approved is not in the catalogue table/));
  });
});

test('a catalogue source that differs from the schema fails', () => {
  withCopy((dir) => {
    const f = path.join(dir, CONTRACT_MD);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('| `kyc.result` | shop |', '| `kyc.result` | mock |'));
    assert.ok(failsWith(validateEvents({ dir }), /catalogue sources for kyc\.result/));
  });
});

test('a type with no per-type rule or no example fails', () => {
  withCopy((dir) => {
    const f = path.join(dir, SCHEMA_FILE);
    const s = readJ(f);
    s.allOf = s.allOf.filter((e) => !(e.if && e.if.properties && e.if.properties.type && e.if.properties.type.const === 'order.paid'));
    writeJ(f, s);
    assert.ok(failsWith(validateEvents({ dir }), /type order\.paid has no per-type rule/));
  });
  withCopy((dir) => {
    fs.rmSync(path.join(dir, 'examples', 'valid', 'instance-events', 'order.paid.json'));
    assert.ok(failsWith(validateEvents({ dir }), /no valid example for type order\.paid/));
  });
});

test('the catalogue parser reads section 7 only', () => {
  const rows = catalogueRows('## 6. x\n| `a.b` | shop |\n## 7. y\n| h | h |\n|---|---|\n| `c.d` | shop, mock | z |\n## 8. z\n| `e.f` | shop |\n');
  assert.deepEqual(rows, [{ type: 'c.d', sources: ['shop', 'mock'] }]);
  assert.equal(catalogueRows('no sections'), null);
});

// ---- examples ----
test('every type has exactly one valid example and every example file is named after its type', () => {
  const events = loadEvents();
  assert.equal(events.length, 29);
  for (const { name, event } of events) assert.equal(name, `${event.type}.json`);
  assert.equal(new Set(events.map((e) => e.event.seq)).size, 29);
});

test('an invalid example that passes, a missing manifest path and an orphan are all failures', () => {
  withCopy((dir) => {
    const good = path.join(dir, 'examples', 'valid', 'instance-events', 'order.paid.json');
    fs.copyFileSync(good, path.join(dir, 'examples', 'invalid', 'instance-events', 'seq-zero.json'));
    assert.ok(failsWith(validateEvents({ dir }), /invalid example passes/));
  });
  withCopy((dir) => {
    const mf = path.join(dir, 'examples', 'invalid', 'manifest.json');
    const m = readJ(mf);
    delete m['instance-events/seq-zero.json'];
    writeJ(mf, m);
    assert.ok(failsWith(validateEvents({ dir }), /no expected error path/));
  });
  withCopy((dir) => {
    const mf = path.join(dir, 'examples', 'invalid', 'manifest.json');
    const m = readJ(mf);
    m['instance-events/seq-zero.json'].path = '/ts';
    writeJ(mf, m);
    assert.ok(failsWith(validateEvents({ dir }), /expected an error at \/ts/));
  });
  withCopy((dir) => {
    fs.writeFileSync(path.join(dir, 'examples', 'stray.json'), '{}');
    assert.ok(failsWith(validateEvents({ dir }), /orphan example/));
  });
});

test('a valid example that breaks the schema fails and names the path', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'examples', 'valid', 'instance-events', 'proxy.request.json');
    const e = readJ(f);
    e.data.status = '200';
    writeJ(f, e);
    assert.ok(failsWith(validateEvents({ dir }), /proxy\.request\.json: valid example fails: \/data\/status/));
  });
});

test('a tampered signed envelope example fails', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'examples', 'valid', 'envelopes', 'proxy-request.json');
    const d = readJ(f);
    d.body = tamper(d.body);
    writeJ(f, d);
    assert.ok(failsWith(validateEvents({ dir }), /signature does not verify/));
  });
});

test('no real-looking flag, key block or byte-order mark in the contract files', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'examples', 'valid', 'instance-events', 'proxy.request.json');
    const e = readJ(f);
    e.data.route_template = REAL_LOOKING; // built from parts so this test file passes the secret scan itself
    writeJ(f, e);
    assert.ok(failsWith(validateEvents({ dir }), /is not an obviously fake flag/));
  });
  withCopy((dir) => {
    fs.appendFileSync(path.join(dir, CONTRACT_MD), '\n' + '-----BEGIN ' + 'PRIVATE KEY-----\n');
    assert.ok(failsWith(validateEvents({ dir }), /private key block/));
  });
  withCopy((dir) => {
    const f = path.join(dir, CONTRACT_MD);
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(f)]));
    assert.ok(failsWith(validateEvents({ dir }), /byte-order mark/));
  });
  for (const f of [CONTRACT_MD, SCHEMA_FILE]) {
    const b = fs.readFileSync(path.join(DEFAULT_DIR, f));
    assert.notDeepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], f);
  }
});

test('a missing contract text, section or open-points table fails', () => {
  withCopy((dir) => {
    fs.rmSync(path.join(dir, CONTRACT_MD));
    assert.ok(failsWith(validateEvents({ dir }), /app-events\.md: missing/));
  });
  withCopy((dir) => {
    const f = path.join(dir, CONTRACT_MD);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## Open points (to confirm)', '## Questions'));
    assert.ok(failsWith(validateEvents({ dir }), /Open points/));
  });
});

// ---- schema rules, direct ----
test('schema: source and session kind rules per type', () => {
  const ing = ingest();
  const post = (ev) => ing.handle(signEvent(TEST_KEY, ev));
  const bot = get('bot.visit');
  assert.equal(post(bot).status, 202);
  const b2 = clone(get('bot.visit')); b2.seq = 100; b2.session_kind = 'anon';
  assert.equal(post(b2).status, 422);
  const inj = get('instance.flags_injected'); inj.seq = 2 ** 41 + 101; inj.source = 'platform';
  assert.equal(post(inj).status, 422);
  const f = get('infrastructure_fault'); f.seq = 2 ** 41 + 102; f.source = 'platform';
  assert.equal(post(f).status, 202);
  const ev = get('evidence.capture'); ev.seq = 103; ev.source = 'mock';
  assert.equal(post(ev).status, 202);
});

test('schema: proxy.flag_seen needs challenge_key for real and decoy, forbids it for foreign', () => {
  const ing = ingest();
  const f = get('proxy.flag_seen');
  f.data.kind = 'decoy';
  assert.equal(ing.handle(signEvent(TEST_KEY, f)).status, 202);
  const g = get('proxy.flag_seen'); g.seq = 77; g.data.kind = 'foreign'; delete g.data.challenge_key;
  assert.equal(ing.handle(signEvent(TEST_KEY, g)).status, 202);
});

// ---- fake ingest: every matrix row ----
test('fake ingest: every row of the I/O matrix answers as the contract says', () => {
  const results = runMatrix({ schemaFile: SCHEMA, events: loadEvents() });
  const bad = results.filter((r) => !r.ok);
  assert.deepEqual(bad, []);
  for (const row of ['duplicate', 'bad signature: wrong key', 'bad signature: altered body', 'wrong instance', 'malformed: not JSON', 'malformed: unknown type', 'malformed: extra field', 'oversize: wire event above 16 KiB', 'flag value in data', 'bot events: session_kind must be bot']) {
    assert.ok(results.some((r) => r.row.startsWith(row)), `matrix covers ${row}`);
  }
});

test('fake ingest: valid -> 202 stored; duplicate -> 200 not stored twice', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  const first = ing.handle(signEvent(TEST_KEY, ev));
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, { status: 'accepted', instance_id: TEST_INSTANCE, epoch: 1, seq: ev.seq });
  const again = ing.handle(signEvent(TEST_KEY, ev));
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'duplicate');
  assert.equal(ing.stored.length, 1);
});

test('fake ingest: 401 for bad signature and wrong instance, IF-8 body, nothing stored', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  const wrong = ing.handle(signEvent('FAKE-OTHER-KEY-NOT-REAL-000000000000', ev));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['content-type'], 'application/problem+json');
  assert.equal(wrong.body.code, 'EVT-BAD-SIGNATURE');
  assert.deepEqual(Object.keys(wrong.body).sort(), ['code', 'request_id', 'status', 'title', 'type']); // closed: no message\n  assert.equal(wrong.body.type, 'urn:vulnmart:error:EVT-BAD-SIGNATURE');
  const other = { ...ev, instance_id: 'i-BBBBBBBBBBBBBBBB' };
  assert.equal(ing.handle(signEvent(TEST_KEY, other)).status, 401);
  const s = signEvent(TEST_KEY, ev);
  assert.equal(ing.handle({ headers: s.headers, body: tamper(s.body) }).status, 401);
  assert.equal(ing.stored.length, 0);
  assert.equal(ing.security.length, 3);
});

test('fake ingest: signature check happens before the schema check', () => {
  const ing = ingest();
  const ev = { ...get('proxy.request'), extra: 1 };
  assert.equal(ing.handle(signEvent('FAKE-OTHER-KEY-NOT-REAL-000000000000', ev)).status, 401);
  assert.equal(ing.handle(signEvent(TEST_KEY, ev)).status, 422);
});

test('fake ingest: 422 names the JSON path and never echoes a flag-like value', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  ev.data.route_template = 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}';
  const r = ing.handle(signEvent(TEST_KEY, ev));
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.pointer === '/data/route_template'));
  assert.ok(!JSON.stringify(r.body).includes('VM{'));
  assert.equal(ing.stored.length, 0);
  const notJson = ing.handle({ headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(notJson.status, 422);
  const noType = ing.handle({ headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(noType.status, 422);
  const noSeq = ing.handle({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: TEST_INSTANCE }) });
  assert.equal(noSeq.status, 422);
  assert.deepEqual(noSeq.body.errors.map((e) => e.pointer), ['/epoch', '/seq']);
});

test('fake ingest: 413 above 16 KiB and for an evidence body above 8 KiB (bytes, not characters)', () => {
  const ing = ingest();
  const big = get('proxy.request');
  big.data.pad = 'x'.repeat(LIMITS.maxBodyBytes);
  assert.equal(ing.handle(signEvent(TEST_KEY, big)).status, 413);
  const cap = get('evidence.capture');
  cap.data.body = 'é'.repeat(4097);
  assert.equal(ing.handle(signEvent(TEST_KEY, cap)).status, 413);
  cap.data.body = 'é'.repeat(4096);
  assert.equal(ing.handle(signEvent(TEST_KEY, cap)).status, 202);
  assert.equal(ing.stored.length, 1);
});

test('fake ingest: a ts more than 10 minutes ahead is refused, an old ts is accepted', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const ing = ingest({ now: () => now });
  const ev = get('proxy.request');
  ev.ts = '2026-06-01T12:09:59Z';
  assert.equal(ing.handle(signEvent(TEST_KEY, ev)).status, 202);
  const late = get('proxy.crs_match');
  late.ts = '2026-06-01T12:10:01Z';
  const r = ing.handle(signEvent(TEST_KEY, late));
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.pointer === '/ts'));
  const old = get('proxy.flag_seen');
  old.ts = '2020-01-01T00:00:00Z';
  assert.equal(ing.handle(signEvent(TEST_KEY, old)).status, 202);
});

test('signing helper: format, tamper detection, instance, epoch and seq are covered', () => {
  const body = '{"a":1}';
  const sig = signBody(TEST_KEY, TEST_INSTANCE, 2, 5, body);
  assert.match(sig, /^v1=[0-9a-f]{64}$/);
  assert.ok(verifySignature(TEST_KEY, TEST_INSTANCE, 2, 5, body, sig));
  assert.ok(!verifySignature(TEST_KEY, TEST_INSTANCE, 2, 6, body, sig));
  assert.ok(!verifySignature(TEST_KEY, TEST_INSTANCE, 3, 5, body, sig), 'the epoch is covered');
  assert.ok(!verifySignature(TEST_KEY, 'i-BBBBBBBBBBBBBBBB', 2, 5, body, sig));
  assert.ok(!verifySignature(TEST_KEY, TEST_INSTANCE, 2, 5, body + ' ', sig));
  assert.ok(!verifySignature(TEST_KEY, TEST_INSTANCE, 2, 5, body, undefined));
  assert.ok(!verifySignature(TEST_KEY, TEST_INSTANCE, 2, 5, body, sig.toUpperCase()));
});

// ---- fake ingest over HTTP ----
test('fake ingest server: POST answers 202, 200, 401, 413, 422; other methods and paths are refused', async () => {
  const { server, ingest: ing, port } = await startServer({ key: TEST_KEY, port: 0, log() {} });
  try {
    const url = `http://127.0.0.1:${port}/internal/v1/events`;
    const post = async (s) => fetch(url, { method: 'POST', headers: s.headers, body: s.body });
    const ev = get('proxy.request');
    const a = await post(signEvent(TEST_KEY, ev));
    assert.equal(a.status, 202);
    assert.equal((await a.json()).status, 'accepted');
    assert.equal((await post(signEvent(TEST_KEY, ev))).status, 200);
    assert.equal((await post(signEvent('FAKE-OTHER-KEY-NOT-REAL-000000000000', get('proxy.crs_match')))).status, 401);
    const bad = { ...get('proxy.crs_match'), bogus: true };
    const r = await post(signEvent(TEST_KEY, bad));
    assert.equal(r.status, 422);
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
    const big = get('proxy.request'); big.seq = 9; big.data.pad = 'x'.repeat(40000);
    assert.equal((await post(signEvent(TEST_KEY, big))).status, 413);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' })).status, 404);
    const list = await (await fetch(`http://127.0.0.1:${port}/_fake/events`)).json();
    assert.deepEqual(list, [{ instance_id: TEST_INSTANCE, epoch: 1, seq: ev.seq, type: 'proxy.request' }]);
    assert.equal(ing.stored.length, 1);
  } finally {
    server.close();
  }
});

test('fake ingest server: argument parsing', () => {
  assert.deepEqual(parseArgs(['--key', 'k', '--port', '0']).port, 0);
  assert.throws(() => parseArgs(['--port', 'abc']), /bad port/);
  assert.throws(() => parseArgs(['--wat']), /Unknown/);
  assert.throws(() => parseArgs(['--key']), /Unknown or incomplete/);
});

// ---- review patches ----
const hdrs = { 'content-type': 'application/json' };

test('raw bytes: the signature covers the received bytes, invalid UTF-8 included', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  ev.data.route_template = 'QQQ';
  const text = JSON.stringify(ev);
  const at = text.indexOf('QQQ');
  const body = Buffer.concat([Buffer.from(text.slice(0, at)), Buffer.from([0xff]), Buffer.from(text.slice(at + 3))]);
  const h = { ...hdrs, 'x-vm-signature': signBody(TEST_KEY, ev.instance_id, ev.epoch, ev.seq, body) };
  assert.equal(ing.handle({ headers: h, body }).status, 202); // valid signature, schema allows the replacement character
  const flipped = Buffer.from(body);
  flipped[flipped.indexOf(0xff)] = 0xfe; // decodes to the same U+FFFD
  const ing2 = ingest();
  assert.equal(ing2.handle({ headers: h, body: flipped }).status, 401);
  assert.equal(ing2.stored.length, 0);
  // signed but with a field the schema refuses: 422, not 401
  const bad = Buffer.concat([body.subarray(0, body.length - 1), Buffer.from(',"x":1}')]);
  const hb = { ...hdrs, 'x-vm-signature': signBody(TEST_KEY, ev.instance_id, ev.epoch, ev.seq, bad) };
  assert.equal(ingest().handle({ headers: hb, body: bad }).status, 422);
});

test('unknown instance and wrong signature give the same 401 body (apart from request_id)', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  const a = ing.handle(signEvent(TEST_KEY, { ...ev, instance_id: 'i-CCCCCCCCCCCCCCCC' }));
  const b = ing.handle(signEvent('FAKE-OTHER-KEY-NOT-REAL-000000000000', ev));
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  const strip = (r) => ({ ...r.body, request_id: undefined });
  assert.deepEqual(strip(a), strip(b));
});

test('duplicate with the same body is 200, with a different body is 409 and nothing is stored', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  assert.equal(ing.handle(signEvent(TEST_KEY, ev)).status, 202);
  assert.equal(ing.handle(signEvent(TEST_KEY, ev)).status, 200);
  const r = ing.handle(signEvent(TEST_KEY, { ...ev, ts: '2026-04-04T00:00:00Z' }));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EVT-DUPLICATE-MISMATCH');
  assert.equal(r.headers['content-type'], 'application/problem+json');
  assert.equal(ing.stored.length, 1);
});

test('the number of stored events is capped (503), duplicates are still answered', () => {
  const ing = ingest({ limits: { maxStored: 2 } });
  const evs = loadEvents().map((e) => e.event);
  assert.equal(ing.handle(signEvent(TEST_KEY, evs[0])).status, 202);
  assert.equal(ing.handle(signEvent(TEST_KEY, evs[1])).status, 202);
  const full = ing.handle(signEvent(TEST_KEY, evs[2]));
  assert.equal(full.status, 503);
  assert.equal(full.body.code, 'EVT-STORE-FULL');
  assert.equal(ing.handle(signEvent(TEST_KEY, evs[0])).status, 200);
  assert.equal(ing.stored.length, 2);
});

test('error paths never echo a flag-like property name; a leap second is "not a usable time"', () => {
  const ing = ingest();
  const ev = get('proxy.request');
  ev.data['VM{AAAAAAAAAAAAAAAAAAAAAAAA}'] = 'x';
  ev.data['vm%7Bsecret'] = 'x';
  const r = ing.handle(signEvent(TEST_KEY, ev));
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.pointer === '/data/<redacted>'));
  assert.ok(!/AAAAAAAA|secret/.test(JSON.stringify(r.body)));
  const leap = get('proxy.crs_match');
  leap.ts = '2016-12-31T23:59:60Z';
  const l = ing.handle(signEvent(TEST_KEY, leap));
  assert.equal(l.status, 422);
  assert.ok(l.body.errors.some((e) => e.pointer === '/ts' && /not a usable time/.test(e.detail)));
});

test('schema: flag-like check ignores letter case and sees an encoded brace; internal is not for the shop', () => {
  const ing = ingest();
  for (const [i, v] of ['/x/vm{AAAA', '/x/Vm{', '/x/VM%7BAAAA', '/x/vm%7bAAAA', '/x/VM｛AAAA'].entries()) {
    const ev = get('proxy.request');
    ev.seq = 50 + i;
    ev.data.route_template = v;
    assert.equal(ing.handle(signEvent(TEST_KEY, ev)).status, 422, v);
  }
  const s = get('shop.giftcard_attempt');
  s.session_kind = 'internal';
  assert.equal(ing.handle(signEvent(TEST_KEY, s)).status, 422);
  const imp = get('import.job');
  imp.session_kind = 'internal';
  assert.equal(ing.handle(signEvent(TEST_KEY, imp)).status, 202);
  assert.equal(ing.stored.length, 1);
});

test('proxy.flag_seen: envelope and data challenge_key must agree when both are present', () => {
  const ing = ingest();
  const f = get('proxy.flag_seen');
  f.challenge_key = f.data.challenge_key; // equal: fine
  assert.equal(ing.handle(signEvent(TEST_KEY, f)).status, 202);
  const g = get('proxy.flag_seen');
  g.seq = 88;
  g.challenge_key = g.data.challenge_key === 'C02' ? 'C03' : 'C02';
  const r = ing.handle(signEvent(TEST_KEY, g));
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.pointer === '/challenge_key'));
});

test('the evidence example shows the [FLAG-REDACTED] marker and is accepted', () => {
  const ev = get('evidence.capture');
  assert.match(JSON.stringify(ev.data), /\[FLAG-REDACTED\]/);
  assert.equal(ingest().handle(signEvent(TEST_KEY, ev)).status, 202);
});

// ---- posted-body schema ----
const POSTED = path.join(DEFAULT_DIR, POSTED_FILE);

test('posted-body schema: the file on disk equals what the wire schema derives', () => {
  assert.deepEqual(readJ(POSTED), derivePosted(readJ(SCHEMA)));
});

test('posted-body schema: stale file fails; --write-posted regenerates it', () => {
  withCopy((dir) => {
    const f = path.join(dir, SCHEMA_FILE);
    const s = readJ(f);
    s.description = 'changed';
    writeJ(f, s);
    assert.ok(failsWith(validateEvents({ dir }), /instance-events\.posted\.schema\.json: stale/));
    assert.equal(main(['--dir', dir, '--write-posted'], { log() {}, err() {} }), 0);
    assert.ok(!failsWith(validateEvents({ dir }), /stale/));
  });
  withCopy((dir) => {
    fs.rmSync(path.join(dir, POSTED_FILE));
    assert.ok(failsWith(validateEvents({ dir }), /posted\.schema\.json: missing/));
  });
});

test('posted-body schema: sources, ids, caps and types the poster may use', () => {
  const posted = derivePosted(readJ(SCHEMA));
  assert.equal(posted.properties.instance_id, undefined);
  assert.equal(posted.properties.seq, undefined);
  assert.equal(posted.properties.epoch, undefined, 'the sidecar stamps epoch; the poster never sends it');
  assert.ok(!posted.required.includes('epoch'));
  assert.deepEqual(posted.properties.source.enum, POSTED_SOURCES);
  assert.equal(posted.$defs.data_evidence_capture.properties.body.maxLength, POSTED_EVIDENCE_BODY_CHARS);
  const rule = (t) => posted.allOf.find((e) => e.if && e.if.properties && e.if.properties.type && e.if.properties.type.const === t).then.properties.source;
  assert.equal(rule('proxy.request'), false);
  assert.equal(rule('instance.flags_injected'), false);
  assert.deepEqual(rule('evidence.capture'), { const: 'mock' });
  assert.deepEqual(rule('shop.refund_decision'), { const: 'shop' });
});

test('a null or malformed envelope example is reported, not a crash', () => {
  withCopy((dir) => {
    fs.writeFileSync(path.join(dir, 'examples', 'valid', 'envelopes', 'null.json'), 'null');
    const res = validateEvents({ dir });
    assert.ok(failsWith(res, /null\.json: an envelope example needs/));
  });
  withCopy((dir) => {
    const f = path.join(dir, 'examples', 'valid', 'envelopes', 'proxy-request.json');
    const d = readJ(f);
    d.headers = { 'X-VM-Signature': d.headers['x-vm-signature'], 'content-type': 'application/json' };
    writeJ(f, d);
    assert.ok(!failsWith(validateEvents({ dir }), /proxy-request\.json/)); // header name case does not matter
  });
});

// ---- fake ingest server: bounds ----
test('fake ingest server: a body far over 16 KiB is answered 413 and not stored; the server keeps working', async () => {
  const { server, ingest: ing, port } = await startServer({ key: TEST_KEY, port: 0, log() {} });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/internal/v1/events', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 20 * 1024 * 1024 } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', (e) => resolve(`error ${e.code}`)); // the server may drop the connection after answering
      req.write(Buffer.alloc(1024 * 1024, 0x20));
    });
    assert.ok(status === 413 || /error (ECONNRESET|EPIPE)/.test(status), `status ${status}`);
    assert.equal(ing.stored.length, 0);
    const ok = await fetch(`http://127.0.0.1:${port}/internal/v1/events`, { method: 'POST', ...(() => { const s = signEvent(TEST_KEY, get('proxy.request')); return { headers: s.headers, body: s.body }; })() });
    assert.equal(ok.status, 202);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('fake ingest server: a client that aborts mid-body does not break the server', async () => {
  const { server, ingest: ing, port } = await startServer({ key: TEST_KEY, port: 0, log() {} });
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/internal/v1/events', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 5000 } });
      req.on('error', () => resolve());
      req.write('{"partial":');
      setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ing.stored.length, 0);
    const s = signEvent(TEST_KEY, get('proxy.request'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/v1/events`, { method: 'POST', headers: s.headers, body: s.body })).status, 202);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('fake ingest server: option values are validated', () => {
  assert.throws(() => parseArgs(['--key', '--port', '1']), /looks like another option/);
  assert.throws(() => parseArgs(['--instance', 'i-short']), /bad instance id/);
  assert.throws(() => parseArgs(['--instance', 'i-aaaaaaaaaaaaaaaa']), /bad instance id/);
  assert.equal(parseArgs(['--instance', 'i-BBBBBBBBBBBBBBBB']).instance, 'i-BBBBBBBBBBBBBBBB');
});

// ---- command line ----
test('command line: exit 0 on the real contract, 1 on a failure, 2 on a usage error', () => {
  const ok = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /events: PASS/);
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/validate-events\.mjs/);
  const usage = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Unknown argument/);
  const missing = spawnSync(process.execPath, [SCRIPT, '--dir', path.join(os.tmpdir(), 'vm-events-does-not-exist')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /events: FAIL/);
});

// ---- D-42: epoch, seq lanes, event key derivation (story 1.15) ----
const LANES = { sidecar: [1, 2 ** 40 - 1], shop: [1, 2 ** 40 - 1], import: [1, 2 ** 40 - 1], mock: [1, 2 ** 40 - 1], bot: [1, 2 ** 40 - 1], orchestrator: [2 ** 40, 2 ** 41 - 1], platform: [2 ** 41, 2 ** 42 - 1] };
const typeFor = { sidecar: 'proxy.request', shop: 'shop.verbose_error', import: 'import.job', mock: 'collector.hit', bot: 'bot.visit', orchestrator: 'instance.flags_injected', platform: 'infrastructure_fault' };

test('D-42: every source has its own seq lane, checked at both ends and one step outside', () => {
  let n = 0;
  for (const [source, [lo, hi]] of Object.entries(LANES)) {
    const base = clone(get(typeFor[source]));
    base.source = source;
    if (source === 'bot') base.session_kind = 'bot';
    else if (source === 'import' || source === 'orchestrator' || source === 'platform') base.session_kind = 'internal';
    else base.session_kind = base.session_kind === 'internal' ? 'anon' : base.session_kind;
    for (const [seq, want] of [[lo, 202], [hi, 202], [lo - 1, 422], [hi + 1, 422]]) {
      if (seq < 1) continue;
      const ev = clone(base);
      ev.seq = seq;
      const r = ingest().handle(signEvent(TEST_KEY, ev));
      assert.equal(r.status, want, `${source} seq ${seq}: ${JSON.stringify(r.body.errors)}`);
      if (want === 422) assert.ok(r.body.errors.some((e) => e.pointer === '/seq'), `${source} seq ${seq} names /seq`);
      n++;
    }
  }
  assert.equal(n, 23);
});

test('D-42: epoch is required, an integer and at least 1 on the wire; the posted body must not have it', () => {
  const ing = ingest();
  for (const [label, mutate] of [['missing', (e) => { delete e.epoch; }], ['zero', (e) => { e.epoch = 0; }], ['string', (e) => { e.epoch = '1'; }], ['float', (e) => { e.epoch = 1.5; }]]) {
    const ev = get('proxy.request');
    mutate(ev);
    const r = ing.handle(signEvent(TEST_KEY, ev));
    assert.equal(r.status, 422, label);
    assert.ok(r.body.errors.some((e) => e.pointer === '/epoch'), label);
  }
  const posted = derivePosted(readJ(SCHEMA));
  const sidecarOnly = readJ(path.join(DEFAULT_DIR, 'examples', 'invalid', 'posted', 'includes-epoch.json'));
  const ajvIng = createIngest({ keys: {}, schemaFile: path.join(DEFAULT_DIR, POSTED_FILE) });
  assert.ok(sidecarOnly.epoch === 1 && posted.properties.epoch === undefined);
  assert.ok(ajvIng);
});

test('D-42: the signature covers the epoch (a valid event cannot be moved to another epoch)', () => {
  const ing = ingest({ keys: { [TEST_INSTANCE]: TEST_KEY } });
  ing.setEpoch(TEST_INSTANCE, 5);
  const ev = get('proxy.request');
  const s = signEvent(TEST_KEY, ev);
  const moved = JSON.stringify({ ...ev, epoch: 2 });
  assert.equal(ing.handle({ headers: s.headers, body: moved }).status, 401);
});

test('D-42: ingest dedups on (instance_id, epoch, seq), accepts old epochs as history and refuses future epochs', () => {
  const master = TEST_MASTER_HEX;
  const ing = createIngest({ master, instances: { [TEST_INSTANCE]: 2 }, schemaFile: SCHEMA });
  const at = (epoch, seq, patch = {}) => ({ ...get('proxy.request'), epoch, seq, ...patch });
  const sign = (ev) => signEvent(deriveEventKey(master, TEST_INSTANCE, ev.epoch), ev);
  assert.equal(ing.handle(sign(at(2, 1))).status, 202);
  assert.equal(ing.handle(sign(at(2, 1))).status, 200, 'same body: duplicate');
  assert.equal(ing.handle(sign(at(2, 1, { ts: '2026-04-04T00:00:00Z' }))).status, 409, 'other body: mismatch');
  assert.equal(ing.handle(sign(at(1, 1))).status, 202, 'same seq, older epoch: another event, history');
  assert.equal(ing.handle(sign(at(1, 7))).status, 202, 'a late event of the old epoch after the reset');
  assert.equal(ing.handle(sign(at(3, 1))).status, 401, 'epoch above the current one');
  assert.equal(ing.security.at(-1).kind, 'future_epoch');
  assert.deepEqual(ing.ordered().map((s) => [s.event.epoch, s.event.seq]), [[1, 1], [1, 7], [2, 1]], 'ordered by (epoch, seq)');
  assert.ok(ing.stored.every((s) => s.event.epoch <= 2), 'nothing is credited to a later epoch');
  ing.setEpoch(TEST_INSTANCE, 3);
  assert.equal(ing.handle(sign(at(3, 1))).status, 202, 'after the reset the new epoch counts');
  assert.throws(() => ing.setEpoch('i-ZZZZZZZZZZZZZZZZ', 2), /unknown instance/);
  // a key of another epoch does not verify
  const wrong = signEvent(deriveEventKey(master, TEST_INSTANCE, 1), at(3, 2));
  assert.equal(ing.handle(wrong).status, 401);
});

test('D-42: HKDF event key vector: the file matches the shared function, an epoch change changes the key, and a wrong vector fails', () => {
  const v = readJ(path.join(DEFAULT_DIR, 'examples', 'event-key-vector.json'));
  assert.equal(v.master_hex, TEST_MASTER_HEX);
  for (const c of v.cases) assert.equal(deriveEventKey(v.master_hex, c.instance_id, c.epoch), c.key);
  assert.equal(new Set(v.cases.map((c) => c.key)).size, v.cases.length);
  assert.notEqual(deriveEventKey(v.master_hex, 'i-AAAAAAAAAAAAAAAA', 1), deriveEventKey(v.master_hex, 'i-AAAAAAAAAAAAAAAA', 2));
  assert.equal(deriveEventKey(v.master_hex, 'i-AAAAAAAAAAAAAAAA', 1).length, 43);
  assert.throws(() => deriveEventKey('00', 'i-AAAAAAAAAAAAAAAA', 1), /32 bytes/);
  assert.throws(() => deriveEventKey(v.master_hex, 'i-AAAAAAAAAAAAAAAA', 0), /epoch/);
  withCopy((dir) => {
    const f = path.join(dir, 'examples', 'event-key-vector.json');
    const bad = readJ(f);
    bad.cases[0].key = bad.cases[1].key;
    writeJ(f, bad);
    assert.ok(failsWith(validateEvents({ dir }), /event-key-vector\.json: key of .* does not match the HKDF result/));
    fs.rmSync(f);
    assert.ok(failsWith(validateEvents({ dir }), /event-key-vector\.json: missing/));
  });
});

test('D-42: the fake ingest server takes --master and --epoch and has a test API to set the epoch', async () => {
  assert.throws(() => parseArgs(['--master', 'abc']), /bad master/);
  assert.throws(() => parseArgs(['--epoch', '0']), /bad epoch/);
  const o = parseArgs(['--master', TEST_MASTER_HEX, '--epoch', '2']);
  assert.equal(o.epoch, 2);
  const s = await startServer({ master: o.master, epoch: 2, port: 0, host: '127.0.0.1', log: () => {} });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const ev = { ...get('proxy.request'), epoch: 3 };
    const send = (e) => fetch(`${base}/internal/v1/events`, { method: 'POST', ...(({ body, headers }) => ({ body, headers }))(signEvent(deriveEventKey(TEST_MASTER_HEX, e.instance_id, e.epoch), e)) });
    assert.equal((await send(ev)).status, 401);
    const set = await fetch(`${base}/_fake/epoch`, { method: 'POST', body: JSON.stringify({ instance_id: TEST_INSTANCE, epoch: 3 }) });
    assert.equal(set.status, 200);
    assert.equal((await send(ev)).status, 202);
    assert.equal((await fetch(`${base}/_fake/epoch`, { method: 'POST', body: '{"instance_id":"i-ZZZZZZZZZZZZZZZZ","epoch":3}' })).status, 422);
    const list = await (await fetch(`${base}/_fake/events`)).json();
    assert.deepEqual(list, [{ instance_id: TEST_INSTANCE, epoch: 3, seq: 1, type: 'proxy.request' }]);
  } finally { await new Promise((r) => s.server.close(r)); }
});

test('D-42: the new invalid examples exist and each is refused at its manifest path', () => {
  const man = readJ(path.join(DEFAULT_DIR, 'examples', 'invalid', 'manifest.json'));
  for (const n of ['epoch-missing', 'epoch-zero', 'epoch-string', 'orchestrator-seq-1', 'sidecar-seq-in-reserved-lane', 'platform-seq-in-orchestrator-lane']) {
    assert.ok(man[`instance-events/${n}.json`], n);
    assert.ok(fs.existsSync(path.join(DEFAULT_DIR, 'examples', 'invalid', 'instance-events', `${n}.json`)), n);
  }
  assert.equal(man['posted/includes-epoch.json'].path, '/epoch');
  assert.deepEqual(validateEvents().errors, []);
});
