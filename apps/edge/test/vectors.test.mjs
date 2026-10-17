// Vector test: every ticket and cookie verdict of the library equals contracts/edge/examples/ticket-vectors.json,
// and the library signs the valid vectors to exactly the same bytes (the format of the contract, not only a round trip).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signCookie, signTicket, verifyCookie, verifyTicket } from '../src/tickets.mjs';

const file = new URL('../../../contracts/edge/examples/ticket-vectors.json', import.meta.url);
const vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
const keys = { current: Buffer.from(vectors.keys.current_hex, 'hex'), previous: Buffer.from(vectors.keys.previous_hex, 'hex') };

test('the vectors file has the expected shape and covers every verdict', () => {
  assert.equal(vectors.version, 1);
  assert.ok(Number.isInteger(vectors.now));
  assert.equal(keys.current.length, 32);
  const seen = new Set([...vectors.tickets, ...vectors.cookies].map((v) => v.expect));
  for (const r of ['ok', 'malformed', 'signature', 'claims']) assert.ok(seen.has(r), `no vector for ${r}`);
  assert.ok(vectors.tickets.some((v) => v.expect === 'expired'));
  assert.ok(vectors.tickets.some((v) => v.expect === 'too-far'));
  assert.ok(vectors.tickets.length >= 30 && vectors.cookies.length >= 10);
});

for (const v of vectors.tickets) {
  test(`ticket vector: ${v.name} -> ${v.expect}`, () => {
    const r = verifyTicket(keys, v.token, vectors.now);
    if (v.expect === 'ok') {
      assert.equal(r.ok, true);
      assert.deepEqual(r.claims, v.claims);
    } else {
      assert.equal(r.ok, false);
      assert.equal(r.reason, v.expect);
    }
  });
}

for (const v of vectors.cookies) {
  test(`cookie vector: ${v.name} -> ${v.expect}`, () => {
    const r = verifyCookie(keys, v.value);
    if (v.expect === 'ok') {
      assert.equal(r.ok, true);
      assert.deepEqual(r.claims, v.claims);
    } else {
      assert.equal(r.ok, false);
      assert.equal(r.reason, v.expect);
    }
  });
}

test('signing the claims of the valid vectors gives the vector bytes (current key)', () => {
  const t = vectors.tickets[0];
  assert.equal(signTicket(keys, t.claims), t.token);
  const c = vectors.cookies[0];
  assert.equal(signCookie(keys, c.claims), c.value);
});

test('a ticket is not a cookie and a cookie is not a ticket (domain separation)', () => {
  assert.equal(verifyCookie(keys, vectors.tickets[0].token).reason, 'signature');
  assert.equal(verifyTicket(keys, vectors.cookies[0].value, vectors.now).reason, 'signature');
});

test('the same ticket changes verdict with the clock only', () => {
  const t = vectors.tickets[0];
  assert.equal(verifyTicket(keys, t.token, vectors.now).ok, true);
  assert.equal(verifyTicket(keys, t.token, t.claims.exp - 1).ok, true);
  assert.equal(verifyTicket(keys, t.token, t.claims.exp).reason, 'expired');
  assert.equal(verifyTicket(keys, t.token, t.claims.exp - 61).reason, 'too-far');
});
