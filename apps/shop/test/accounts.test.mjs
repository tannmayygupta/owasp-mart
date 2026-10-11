// Account identity tests (T-07, FR-SHP-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { createUser, authenticate, DuplicateEmailError } from '../src/identity/accounts.mjs';
import { isStrongHash } from '../src/identity/password.mjs';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('createUser stores a strong password hash, not the password', () => {
  const db = freshDb();
  const u = createUser(db, { email: 'a@shop.test', password: 'hunter2!', role: 'customer' });
  assert.ok(u.id > 0);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
  assert.ok(isStrongHash(row.password_hash), 'stored value is a strong hash');
  assert.ok(!row.password_hash.includes('hunter2!'), 'the password is not stored');
});

test('authenticate returns the user on the right password, null otherwise', () => {
  const db = freshDb();
  createUser(db, { email: 'b@shop.test', password: 'pw-correct', role: 'support_agent' });
  assert.equal(authenticate(db, 'b@shop.test', 'pw-wrong'), null);
  const ok = authenticate(db, 'b@shop.test', 'pw-correct');
  assert.ok(ok && ok.email === 'b@shop.test' && ok.role === 'support_agent');
});

test('authenticate returns null for an unknown email (no user enumeration)', () => {
  const db = freshDb();
  assert.equal(authenticate(db, 'nobody@shop.test', 'whatever'), null);
});

test('a duplicate email is rejected', () => {
  const db = freshDb();
  createUser(db, { email: 'dupe@shop.test', password: 'x1', role: 'customer' });
  assert.throws(() => createUser(db, { email: 'dupe@shop.test', password: 'x2', role: 'customer' }), DuplicateEmailError);
});

test('an unknown role is rejected', () => {
  const db = freshDb();
  assert.throws(() => createUser(db, { email: 'c@shop.test', password: 'x', role: 'root' }), /unknown role/);
});

test('email is normalized: login is case-insensitive and duplicates collapse', () => {
  const db = freshDb();
  createUser(db, { email: '  Mixed@Shop.test ', password: 'pw', role: 'customer' });
  assert.ok(authenticate(db, 'mixed@shop.test', 'pw'), 'lower-case login works');
  assert.ok(authenticate(db, 'MIXED@SHOP.TEST', 'pw'), 'upper-case login works');
  assert.throws(() => createUser(db, { email: 'mixed@shop.test', password: 'pw2', role: 'customer' }), DuplicateEmailError);
});

test('authenticate never returns the password hash', () => {
  const db = freshDb();
  createUser(db, { email: 'd@shop.test', password: 'pw', role: 'finance' });
  const u = authenticate(db, 'd@shop.test', 'pw');
  assert.ok(u && !('password_hash' in u), 'no password_hash field on the returned user');
  assert.deepEqual(Object.keys(u).sort(), ['email', 'id', 'role', 'status', 'store_id']);
});

test('a non-string email returns null, not a crash', () => {
  const db = freshDb();
  assert.equal(authenticate(db, undefined, 'pw'), null);
  assert.equal(authenticate(db, { evil: true }, 'pw'), null);
});
