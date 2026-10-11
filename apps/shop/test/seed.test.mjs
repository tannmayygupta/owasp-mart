// Seed mechanism tests (T-08, FR-SHP-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { discoverContributions, runSeeds, seedAll, contributionFiles, SEED_TIMESTAMP } from '../seed/registry.mjs';
import { buildSnapshot } from '../seed/build-snapshot.mjs';
import { isStrongHash } from '../src/identity/password.mjs';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Read the seed world as data, excluding the random-salted password_hash, so
// two builds can be compared for determinism.
function worldData(db) {
  return {
    users: db.prepare('SELECT id, email, role, store_id, status, created_at FROM users ORDER BY id').all(),
    stores: db.prepare('SELECT id, owner_user_id, name, status, commission_rate_bp, created_at FROM stores ORDER BY id').all(),
    categories: db.prepare('SELECT id, name, parent_id FROM categories ORDER BY id').all(),
    products: db.prepare('SELECT id, store_id, category_id, title, price_cents, stock, status, created_at FROM products ORDER BY id').all(),
  };
}

test('contributions are discovered in filename order', async () => {
  const files = contributionFiles();
  assert.ok(files.length >= 1 && files[0].startsWith('000-'));
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted, 'files are in ascending order');
  const contribs = await discoverContributions();
  assert.equal(contribs.length, files.length);
  for (const c of contribs) assert.equal(typeof c.seed, 'function');
});

test('seedAll populates the baseline world with fixed timestamps', async () => {
  const db = freshDb();
  await seedAll(db);
  const w = worldData(db);
  assert.ok(w.users.length >= 3 && w.stores.length === 2 && w.products.length >= 4);
  for (const row of [...w.users, ...w.stores, ...w.products]) {
    assert.equal(row.created_at, SEED_TIMESTAMP, 'seed rows use the fixed timestamp');
  }
  // Every seeded user password is a strong hash (T-07), never plaintext.
  for (const u of db.prepare('SELECT password_hash FROM users').all()) {
    assert.ok(isStrongHash(u.password_hash));
  }
});

test('the seeded world is deterministic across two builds (FR-SHP-12)', async () => {
  const a = freshDb();
  const b = freshDb();
  await seedAll(a);
  await seedAll(b);
  assert.deepEqual(worldData(a), worldData(b), 'the world data is identical across builds');
});

test('the baseline carries no flag-shaped value', async () => {
  const db = freshDb();
  await seedAll(db);
  const dump = JSON.stringify(worldData(db));
  assert.ok(!/VM\{/.test(dump), 'no flag-shaped value in the seed world');
});

test('runSeeds rolls back and reports a failing contribution', () => {
  const db = freshDb();
  const bad = [{ name: 'bad', seed: () => { throw new Error('boom'); } }];
  assert.throws(() => runSeeds(db, bad), /seed contribution bad failed: boom/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0, 'nothing partially seeded');
});

test('buildSnapshot migrates, seeds, counts and times an in-memory build', async () => {
  const r = await buildSnapshot(':memory:');
  assert.ok(r.counts.users >= 3 && r.counts.products >= 4 && r.counts.stores === 2);
  assert.ok(r.counts.categories >= 4, 'counts are dynamic (categories reported)');
  assert.ok(r.contributions.length >= 1);
  assert.ok(typeof r.elapsedMs === 'number' && r.elapsedMs >= 0);
});

test('buildSnapshot writes an on-disk file and a rebuild over it succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-snap-'));
  const file = path.join(dir, 'snapshot.db');
  try {
    const first = await buildSnapshot(file);
    assert.ok(fs.existsSync(file), 'snapshot file is created');
    assert.equal(first.dbPath, file);
    // A rebuild over the existing file (and any sidecars) must start fresh and
    // yield the same counts, with no UNIQUE/PK conflict from stale rows.
    const second = await buildSnapshot(file);
    assert.deepEqual(second.counts, first.counts, 'rebuild yields the same world counts');
    // The on-disk snapshot opens and holds the seeded world.
    const db = openDb(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products').get().c, first.counts.products);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
