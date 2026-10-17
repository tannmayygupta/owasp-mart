// Session-cookie robustness (PR #14 review B): a crafted cookie must never crash
// a request. decodeURIComponent throws on a malformed percent-escape, so a cookie
// like "vm_sess=%" used to 500 every request through loadUser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, serialize, parse } from '../src/web/session.mjs';

test('a malformed percent-escape in the cookie does not throw; it reads as no session', () => {
  for (const bad of ['vm_sess=%', 'vm_sess=%zz', 'vm_sess=abc%E0%A4', 'vm_sess=%%']) {
    let session;
    assert.doesNotThrow(() => { session = getSession({ headers: { cookie: bad } }); }, `cookie ${bad}`);
    assert.equal(session, null, 'a bad cookie yields no session');
  }
});

test('a validly signed session cookie still round-trips', () => {
  const value = serialize({ uid: 3, csrf: 'abc' });
  assert.deepEqual(parse(value), { uid: 3, csrf: 'abc' });
  // And through the request reader, URL-encoded as a cookie value would be.
  assert.deepEqual(getSession({ headers: { cookie: `vm_sess=${encodeURIComponent(value)}` } }), { uid: 3, csrf: 'abc' });
});

test('an expired session is rejected; a future expiry is accepted', () => {
  const expired = serialize({ uid: 3, csrf: 'x', exp: Date.now() - 1000 });
  assert.equal(parse(expired), null, 'a past exp is treated as no session');
  assert.equal(getSession({ headers: { cookie: `vm_sess=${encodeURIComponent(expired)}` } }), null);
  const live = serialize({ uid: 3, csrf: 'x', exp: Date.now() + 60_000 });
  assert.equal(parse(live).uid, 3, 'a future exp is still valid');
});
