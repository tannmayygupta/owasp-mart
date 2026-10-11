// Password hashing tests (T-07, FR-SHP-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash, verify, isStrongHash, needsRehash, PARAMS, MAX_PASSWORD_LENGTH } from '../src/identity/password.mjs';

test('hash produces a self-describing scrypt string with a salt', () => {
  const h = hash('correct horse battery staple');
  assert.match(h, /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(isStrongHash(h));
});

test('the right password verifies, a wrong one does not', () => {
  const h = hash('s3cret-pass');
  assert.equal(verify('s3cret-pass', h), true);
  assert.equal(verify('s3cret-pazz', h), false);
});

test('two hashes of the same password differ (random salt)', () => {
  assert.notEqual(hash('same'), hash('same'));
});

test('verify never throws on a malformed stored value', () => {
  for (const bad of ['', 'nope', 'md5$abc', 'scrypt$bad', 'scrypt$N=1,r=1,p=1$$', 'scrypt$N=1,r=1,p=1$@@@$@@@', null, undefined, 42]) {
    assert.equal(verify('x', bad), false);
  }
});

test('a legacy/weak format is not accepted as a strong hash', () => {
  assert.equal(isStrongHash('5f4dcc3b5aa765d61d8327deb882cf99'), false); // md5("password")
  assert.equal(isStrongHash('plaintext'), false);
});

test('parameters meet the documented floor (ADR 0018)', () => {
  assert.ok(PARAMS.N >= 32768);
  assert.ok(PARAMS.saltBytes >= 16);
  assert.ok(PARAMS.keylen >= 32);
});

test('isStrongHash rejects a cost-downgraded scrypt string', () => {
  // Well-formed scrypt shape but N=1: must not count as strong.
  const weak = 'scrypt$N=1,r=1,p=1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(32).toString('base64');
  assert.equal(isStrongHash(weak), false);
  assert.equal(needsRehash(weak), true);
});

test('needsRehash is false for a freshly made hash, true for legacy', () => {
  assert.equal(needsRehash(hash('fresh')), false);
  assert.equal(needsRehash('5f4dcc3b5aa765d61d8327deb882cf99'), true);
});

test('a higher-cost stored hash still verifies (maxmem from actual params)', () => {
  const strong = hash('big-cost', { ...PARAMS, N: 65536 });
  assert.equal(verify('big-cost', strong), true);
  assert.equal(verify('wrong', strong), false);
});

test('an over-long password is rejected before hashing', () => {
  assert.throws(() => hash('x'.repeat(MAX_PASSWORD_LENGTH + 1)), /at most/);
  assert.doesNotThrow(() => hash('x'.repeat(MAX_PASSWORD_LENGTH)));
});
