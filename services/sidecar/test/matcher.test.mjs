// The matcher and the decoders (D-73, spike S-9): every channel row of s9-channels.mjs, the classes, the caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createMatcher, SCAN_CAP_BYTES } from '../src/matcher.mjs';
import { decodeBody, jsonUnescape, htmlUnescape, percentDecode, variants } from '../src/decode.mjs';
import { freshValues, startDoc, flagOf, fakeFlag, sha256, gzip } from './helpers.mjs';
import { CHANNELS } from './s9-channels.mjs';

const setup = () => {
  const v = freshValues();
  return { v, m: createMatcher(startDoc(v).flag_digests), flag: flagOf(v, 'C05') };
};

test('S-9: every channel row is seen or not seen as the table says', async () => {
  const { v, m, flag } = setup();
  for (const ch of CHANNELS) {
    const r = ch.build(flag);
    const res = await m.scanResponse(Buffer.from(r.body), r.encoding);
    const real = res.candidates.filter((c) => c.kind === 'real' && c.challenge_key === 'C05');
    assert.equal(real.length === 1, ch.seen, `${ch.id}: expected ${ch.seen ? 'seen' : 'not seen'}`);
    if (ch.seen) assert.equal(real[0].sha256, sha256(flag), `${ch.id}: digest`);
    assert.ok(res.candidates.length <= 1, `${ch.id}: no extra candidate`);
  }
  void v;
});

test('classes: real and decoy come from the digest set with their challenge key; a flag-shaped string in no digest is foreign without a key', async () => {
  const { v, m } = setup();
  const foreign = fakeFlag();
  const text = `a ${flagOf(v, 'C01')} b ${v.decoys[0].value} c ${foreign}`;
  const out = m.scanText(text);
  assert.deepEqual(out.map((c) => [c.kind, c.challenge_key]), [['real', 'C01'], ['decoy', v.decoys[0].challenge_key], ['foreign', undefined]]);
  assert.equal(out[2].sha256, sha256(foreign));
});

test('a candidate is reported once per response however often and however encoded it appears', async () => {
  const { v, m } = setup();
  const f = flagOf(v, 'C02');
  const out = m.scanText(`${f} ${f} ${encodeURIComponent(f)} ${JSON.stringify(f)}`);
  assert.equal(out.length, 1);
});

test('near misses are not candidates: short, long, lowercase letters, characters outside Base32', () => {
  const { m } = setup();
  const LB = String.fromCharCode(123); const RB = String.fromCharCode(125);
  for (const s of ['VM' + LB + 'A'.repeat(23) + RB, 'VM' + LB + 'A'.repeat(25) + RB, 'VM' + LB + 'a'.repeat(24) + RB, 'VM' + LB + '1'.repeat(24) + RB, 'XM' + LB + 'A'.repeat(24) + RB]) {
    const res = m.scanText(s);
    assert.ok(!res.some((c) => c.kind === 'real'), s.length.toString());
    // 25 characters inside the braces never match (the closing brace must follow the 24th)
    if (s.includes('A'.repeat(25))) assert.equal(res.length, 0);
  }
});

test('a bad digest set cannot be built into a matcher (the sidecar then runs as a plain pass-through)', () => {
  assert.throws(() => createMatcher('not a list'));
});

test('decoders: content-encoding lists, expansion bound, bad data, unsupported', async () => {
  const text = Buffer.from('hello '.repeat(100));
  assert.deepEqual((await decodeBody(text, undefined, 1 << 20)).buf, text);
  assert.deepEqual((await decodeBody(text, 'identity', 1 << 20)).buf, text);
  assert.deepEqual((await decodeBody(zlib.brotliCompressSync(gzip(text)), 'gzip, br', 1 << 20)).buf, text, 'a list is undone from the last coding to the first');
  assert.deepEqual((await decodeBody(zlib.deflateRawSync(text), 'deflate', 1 << 20)).buf, text, 'raw deflate is accepted too');
  assert.deepEqual(await decodeBody(Buffer.from('not gzip'), 'gzip', 1 << 20), { ok: false, reason: 'decode_error' });
  assert.deepEqual(await decodeBody(text, 'zstd', 1 << 20), { ok: false, reason: 'unsupported' });
  const bomb = gzip(Buffer.alloc(10 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 20000, 'the bomb is small on the wire');
  assert.deepEqual(await decodeBody(bomb, 'gzip', 1 << 20), { ok: false, reason: 'too_big' });
});

test('text layers: JSON escapes, entities, percent; unknown entities and non-ASCII bytes are left alone', () => {
  assert.equal(jsonUnescape('a\\u0041\\/\\\\\\"\\n'), 'aA/\\"\n');
  assert.equal(htmlUnescape('&#65;&#x42;&lbrace;&amp;&unknownname;&#0;&#99999999;'), 'AB{&&unknownname;&#0;&#99999999;');
  assert.equal(percentDecode('%41%7b%ZZ%C3'), 'A{%ZZ%C3');
  const v = variants('plain');
  assert.deepEqual(v, ['plain'], 'text that no layer changes has one variant');
  assert.ok(variants('%2526%2523').length <= 32, 'the number of variants is bounded');
});

test('the scan cap constant is 1 MiB', () => { assert.equal(SCAN_CAP_BYTES, 1024 * 1024); });
