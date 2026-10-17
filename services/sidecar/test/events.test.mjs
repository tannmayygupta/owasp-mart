// The events the sidecar builds (events.mjs), the evidence capture (capture.mjs), the route templates (route.mjs) and the vendored schemas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, schemaErrors, SCHEMAS } from '../src/common.mjs';
import { flagSeenEvent, evidenceCaptureEvent, proxyRequestEvent, isoNow } from '../src/events.mjs';
import { buildCapture, blankSecrets, redactFlagLike, requestRef, MARKER, BODY_CAP_BYTES } from '../src/capture.mjs';
import { routeTemplate, methodClass } from '../src/route.mjs';
import { SCHEMA_FILES } from '../scripts/sync-schemas.mjs';
import { fakeFlag, sha256, LB, RB } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const wire = compile(SCHEMAS.wire);
const INSTANCE = 'i-' + 'A'.repeat(16);
const envelope = (e, seq = 1) => ({ schema_version: e.schema_version, instance_id: INSTANCE, epoch: 1, seq, type: e.type, source: e.source, session_kind: e.session_kind, user_id: e.user_id, ts: e.ts, ...(e.challenge_key !== undefined ? { challenge_key: e.challenge_key } : {}), data: e.data });
const valid = (e) => { const errs = schemaErrors(wire, envelope(e)); assert.deepEqual(errs, [], JSON.stringify(errs)); };

test('schemas: the copies in services/sidecar/schemas equal the contract files byte for byte', () => {
  for (const [from, to] of SCHEMA_FILES) {
    assert.ok(fs.readFileSync(path.join(ROOT, from)).equals(fs.readFileSync(path.join(HERE, '..', 'schemas', to))), `${to} differs from ${from}: run node services/sidecar/scripts/sync-schemas.mjs`);
  }
});

test('every event type the sidecar can emit passes the wire schema', () => {
  const ts = isoNow();
  const ref = requestRef();
  assert.match(ref, /^r-[A-Z2-7]{16}$/);
  const cap = buildCapture({ method: 'POST', url: '/api/x?a=1', headers: { 'user-agent': 'ua', 'content-type': 'application/json', accept: '*/*', referer: 'http://x/', 'x-requested-with': 'fetch', origin: 'http://x' }, bodyBuf: Buffer.from('{"a":1}') });
  for (const kind of ['real', 'decoy']) valid(flagSeenEvent({ candidate: { kind, sha256: sha256('x'), challenge_key: 'C05' }, routeTemplate: '/a/{id}', requestRef: ref, ts }));
  valid(flagSeenEvent({ candidate: { kind: 'foreign', sha256: sha256('x') }, routeTemplate: '/a', requestRef: ref, ts }));
  valid(evidenceCaptureEvent({ challengeKey: 'C05', requestRef: ref, capture: cap, ts }));
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'other']) valid(proxyRequestEvent({ method: m, routeTemplate: '/x', status: 200, respLen: 0, count: 3, ts }));
  assert.equal(proxyRequestEvent({ method: 'GET', routeTemplate: '/x', status: 200, respLen: 5, count: 1, ts }).data.count, 1);
  assert.equal(proxyRequestEvent({ method: 'GET', routeTemplate: '/x', status: 200, respLen: 5, count: 9e9, ts }).data.count, 1000000, 'the count is clamped to the schema maximum');
});

test('flag_seen: challenge key in envelope and data for real and decoy, in neither for foreign; proxy events say source sidecar, player, no user (D-76)', () => {
  const ts = isoNow();
  const real = flagSeenEvent({ candidate: { kind: 'real', sha256: sha256('a'), challenge_key: 'C07' }, routeTemplate: '/', requestRef: 'r-AAAAAAAAAAAAAAAA', ts });
  assert.equal(real.challenge_key, 'C07'); assert.equal(real.data.challenge_key, 'C07');
  const foreign = flagSeenEvent({ candidate: { kind: 'foreign', sha256: sha256('a'), challenge_key: 'C07' }, routeTemplate: '/', requestRef: 'r-AAAAAAAAAAAAAAAA', ts });
  assert.equal(foreign.challenge_key, undefined); assert.equal('challenge_key' in foreign.data, false);
  for (const e of [real, foreign]) { assert.equal(e.source, 'sidecar'); assert.equal(e.session_kind, 'player'); assert.equal(e.user_id, null); }
});

test('capture: secret fields are blanked in JSON and form bodies and in the query; flags in any plain, percent or full-width form become the marker', () => {
  const f = fakeFlag();
  assert.equal(blankSecrets('{"user":"a","password":"p w","Token":"t","nested":{"api_key":"k"},"authorization": "Bearer x","cookie":1}'), '{"user":"a","password":"","Token":"","nested":{"api_key":""},"authorization": "","cookie":""}');
  assert.equal(blankSecrets('user=a&passwd=secret&x=1&access_token=zz'), 'user=a&passwd=&x=1&access_token=');
  assert.equal(blankSecrets('GET /x?token=abc&y=1'), 'GET /x?token=&y=1');
  assert.equal(redactFlagLike(`a ${f} b`), `a ${MARKER} b`);
  assert.equal(redactFlagLike(`a VM%7BABC%7D b`), `a ${MARKER} b`);
  assert.equal(redactFlagLike(`a vm${LB}cut`), `a ${MARKER}`);
  const c = buildCapture({ method: 'POST', url: `/x?flag=${f}&password=pw`, headers: { 'user-agent': `ua ${f}`, authorization: 'Bearer nope', cookie: 'sid=nope', 'x-other': 'no' }, bodyBuf: Buffer.from(`{"password":"pw","guess":"${f}"}`) });
  assert.ok(!c.body.includes('VM' + LB) && !c.body.includes('pw"') && !c.body.includes('password=pw'));
  assert.ok(c.body.includes(MARKER));
  assert.deepEqual(Object.keys(c.headers_redacted), ['user-agent']);
  assert.ok(!c.headers_redacted['user-agent'].includes(f));
});

test('capture: the body is cut at 8 KiB of UTF-8 without breaking a character; headers are cut at 512; only allow-listed headers', () => {
  const big = Buffer.from('é'.repeat(6000)); // 12000 bytes
  const c = buildCapture({ method: 'POST', url: '/x', headers: { accept: 'a'.repeat(900) }, bodyBuf: big });
  assert.ok(Buffer.byteLength(c.body) <= BODY_CAP_BYTES);
  assert.ok(!c.body.includes(String.fromCharCode(0xfffd)), 'no half character');
  assert.equal(c.headers_redacted.accept.length, 512);
  const e = evidenceCaptureEvent({ challengeKey: 'C01', requestRef: requestRef(), capture: c, ts: isoNow() });
  assert.deepEqual(schemaErrors(wire, envelope(e)), []);
});

test('capture: a flag hidden in a form the redaction does not read is never sent: the whole body is replaced', () => {
  const f = fakeFlag();
  const hidden = `{"guess":"${[...f].map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')}"}`;
  const c = buildCapture({ method: 'POST', url: '/x', headers: {}, bodyBuf: Buffer.from(hidden) });
  assert.equal(c.body, MARKER);
  const h = buildCapture({ method: 'GET', url: '/x', headers: { referer: `http://x/?q=%26%2386%3BM${LB}` }, bodyBuf: Buffer.alloc(0) });
  assert.ok(!/[Vv][Mm](\{|%7[Bb])/.test(h.headers_redacted.referer));
});

test('route templates: digits, UUIDs, order numbers and flag-like segments become {id}; the query is dropped; 200 characters at most; methods are the enum or other', () => {
  const f = fakeFlag();
  assert.equal(routeTemplate('/api/orders/1234/items?x=1'), '/api/orders/{id}/items');
  assert.equal(routeTemplate('/api/orders/3f2c9a64-1b2d-4c3e-8f90-0a1b2c3d4e5f'), '/api/orders/{id}');
  assert.equal(routeTemplate('/orders/ORD-2026-0042'), '/orders/{id}');
  assert.equal(routeTemplate(`/x/${f}`), '/x/{id}');
  assert.equal(routeTemplate('/x/VM%7Babc'), '/x/{id}');
  assert.equal(routeTemplate('/'), '/');
  assert.equal(routeTemplate(''), '/');
  assert.equal(routeTemplate('/products?q=VM' + LB), '/products');
  assert.equal(routeTemplate('http://shop:3000/a/b?c=d'), '/a/b');
  assert.equal(routeTemplate('*'), '*');
  assert.equal(routeTemplate('nonsense'), '/{other}');
  assert.ok(routeTemplate('/' + 'abc/'.repeat(100)).length <= 200);
  assert.equal(routeTemplate('/' + 'a'.repeat(60)), '/{id}');
  assert.equal(methodClass('GET'), 'GET'); assert.equal(methodClass('PROPFIND'), 'other'); assert.equal(methodClass('get'), 'other');
  void RB;
});
