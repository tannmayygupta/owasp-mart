// Per-challenge account roster tests (T-16, FR-SHP-08): the known cast is
// seeded, every password is distinct across the whole seeded world (C07 and C09
// differ), each authenticates only its own account, hashes are strong, and the
// world stays deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll, contributionFiles, CONTRIBUTIONS_DIR } from '../seed/registry.mjs';
import { CHALLENGE_ACCOUNTS } from '../seed/contributions/010-challenge-accounts.mjs';
import { authenticate } from '../src/identity/accounts.mjs';
import { isStrongHash } from '../src/identity/password.mjs';

async function freshSeeded() {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  return db;
}

// Every plaintext login password seeded by every contribution, via the
// `seededPasswords` export convention. This is how the cross-challenge no-reuse
// invariant stays true as new contributions (011-, 012-, ...) are added.
async function allSeededPasswords() {
  const out = [];
  for (const file of contributionFiles()) {
    const mod = await import(pathToFileURL(path.join(CONTRIBUTIONS_DIR, file)).href);
    assert.ok(Array.isArray(mod.seededPasswords), `${file} must export seededPasswords (FR-SHP-08)`);
    out.push(...mod.seededPasswords);
  }
  return out;
}

test('the full challenge roster is seeded with the right roles and the player store link', async () => {
  const db = await freshSeeded();
  for (const a of CHALLENGE_ACCOUNTS) {
    const row = db.prepare('SELECT email, role, store_id, status FROM users WHERE id = ?').get(a.id);
    assert.ok(row, `account ${a.email} is seeded`);
    assert.equal(row.email, a.email);
    assert.equal(row.role, a.role);
    assert.equal(row.store_id, a.store);
    assert.equal(row.status, 'active');
  }
  // The player's seller staff belongs to the Harbor store (baseline store 1).
  const staff = db.prepare("SELECT store_id FROM users WHERE email = 'staff.harbor@vulnmart.test'").get();
  assert.equal(staff.store_id, 1);
  // A dormant support agent (C09) and a separate support-agent bot (C03) exist.
  const supports = db.prepare("SELECT email FROM users WHERE role = 'support_agent' ORDER BY email").all().map((r) => r.email);
  assert.deepEqual(supports, ['bot.support@vulnmart.test', 's.iyer@vulnmart.test']);
});

test('each account authenticates as itself with its own password and no other', async () => {
  const db = await freshSeeded();
  for (const a of CHALLENGE_ACCOUNTS) {
    const ok = authenticate(db, a.email, a.password);
    // Must be THIS account, not merely some account of the same role.
    assert.ok(ok, `${a.email} logs in with its own password`);
    assert.equal(ok.id, a.id, `${a.email} authenticates as itself`);
    // Every other account's password must be rejected for this account.
    for (const other of CHALLENGE_ACCOUNTS) {
      if (other.id === a.id) continue;
      assert.equal(authenticate(db, a.email, other.password), null, `${a.email} rejects ${other.email}'s password`);
    }
  }
});

test('no seeded password is reused across any contribution (FR-SHP-08 AC; C07 and C09 differ)', async () => {
  // The whole seeded world, not just this file — stays true as challenges grow.
  const passwords = await allSeededPasswords();
  assert.ok(passwords.length >= CHALLENGE_ACCOUNTS.length + 1, 'baseline + roster passwords collected');
  assert.equal(new Set(passwords).size, passwords.length, 'every seeded password across all contributions is distinct');
  // The explicit AC: the C07 (finance) and C09 (s.iyer) passwords differ.
  const emailPw = (email) => CHALLENGE_ACCOUNTS.find((a) => a.email === email)?.password;
  assert.notEqual(emailPw('finance.ops@vulnmart.test'), emailPw('s.iyer@vulnmart.test'));
});

test('every seeded roster password is a strong hash', async () => {
  const db = await freshSeeded();
  for (const a of CHALLENGE_ACCOUNTS) {
    const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a.id);
    assert.ok(isStrongHash(password_hash), `${a.email} hash is strong`);
  }
});

test('the roster is deterministic across two builds and carries no flag', async () => {
  const a = await freshSeeded();
  const b = await freshSeeded();
  const ids = CHALLENGE_ACCOUNTS.map((x) => x.id);
  const read = (db) =>
    ids.map((id) => db.prepare('SELECT id, email, role, store_id, status, created_at FROM users WHERE id = ?').get(id));
  const rosterA = read(a);
  assert.equal(rosterA.filter(Boolean).length, CHALLENGE_ACCOUNTS.length);
  assert.deepEqual(rosterA, read(b), 'the roster is identical across builds');
  assert.ok(!/VM\{/.test(JSON.stringify(rosterA)), 'no flag-shaped value in the roster');
});
