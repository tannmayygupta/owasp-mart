// Migration tests (T-06): the schema applies on a fresh SQLite database, every
// expected table exists, re-running is a no-op, and foreign keys are enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.mjs';
import { migrate, migrationFiles, MIGRATIONS_DIR } from '../src/db/migrate.mjs';
import { MACHINES } from '../src/domain/state-machines.mjs';

const EXPECTED_TABLES = [
  'users', 'addresses', 'stores', 'categories', 'products', 'reviews',
  'carts', 'cart_items', 'coupons', 'orders', 'order_items', 'payments',
  'commissions', 'payouts', 'refunds', 'disputes', 'tickets', 'ticket_messages',
  'notifications', 'uploads', 'audit_log', 'security_events', 'alerts',
];

function tablesIn(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
}

test('migrate creates every expected table on a fresh database', () => {
  const db = openDb(':memory:');
  const applied = migrate(db);
  assert.deepEqual(applied, [1], 'migration 1 applied');
  const tables = tablesIn(db);
  for (const t of EXPECTED_TABLES) assert.ok(tables.has(t), `table ${t} should exist`);
  assert.ok(tables.has('_migrations'), '_migrations ledger exists');
});

test('about 20 domain tables exist (FR-SHP-02)', () => {
  assert.ok(EXPECTED_TABLES.length >= 20, `expected ~20 tables, listed ${EXPECTED_TABLES.length}`);
});

test('re-running migrate is a no-op', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db), [1]);
  assert.deepEqual(migrate(db), [], 'second run applies nothing');
  assert.equal(migrationFiles().length, 1, 'one migration file so far');
});

test('money columns are integer cents, not floats', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare("SELECT name, type FROM pragma_table_info('products')").all();
  const price = cols.find((c) => c.name === 'price_cents');
  assert.equal(price.type, 'INTEGER');
});

test('foreign keys are enforced', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Inserting a product for a non-existent store must fail with FK on.
  assert.throws(
    () => db.prepare(
      'INSERT INTO products (store_id, title, price_cents) VALUES (?, ?, ?)',
    ).run(999, 'x', 100),
    /FOREIGN KEY/i,
  );
});

test('a status CHECK rejects a value outside its state machine', () => {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'seller_owner')").run('a@b.c', 'h');
  const store = db.prepare("INSERT INTO stores (owner_user_id, name) VALUES (?, 'S')").run(u.lastInsertRowid);
  assert.throws(
    () => db.prepare(
      "INSERT INTO products (store_id, title, price_cents, status) VALUES (?, 'p', 100, 'bogus')",
    ).run(store.lastInsertRowid),
    /CHECK/i,
  );
});

// Pull the allowed values of a `status` CHECK (...) out of a table's DDL.
function statusCheckValues(db, table) {
  const sql = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', table).sql;
  const m = sql.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/);
  assert.ok(m, `${table} has a status CHECK`);
  return new Set(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
}

test('each status column mirrors its state machine (schema <-> machine)', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Fully-mirrored: the column's allowed set equals the machine's states.
  const mirror = {
    stores: 'seller_approval',
    products: 'product',
    order_items: 'fulfilment',
    refunds: 'refund',
    disputes: 'dispute',
    payouts: 'payout',
  };
  for (const [table, machineName] of Object.entries(mirror)) {
    const checkSet = statusCheckValues(db, table);
    const machineSet = MACHINES[machineName].states;
    assert.deepEqual(
      [...checkSet].sort(),
      [...machineSet].sort(),
      `${table}.status must equal the ${machineName} machine states`,
    );
  }
  // orders.status is the post-materialisation subset of the checkout machine.
  const orderSet = statusCheckValues(db, 'orders');
  for (const s of orderSet) {
    assert.ok(MACHINES.checkout.states.has(s), `orders.status "${s}" is a checkout state`);
  }
});

test('a failing migration rolls back atomically and records nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-mig-'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), path.join(tmp, '0001_init.sql'));
  // 0002 creates a table then runs an invalid statement, so the whole file must roll back.
  fs.writeFileSync(
    path.join(tmp, '0002_bad.sql'),
    'CREATE TABLE will_not_persist (id INTEGER);\nINSERT INTO table_that_does_not_exist VALUES (1);\n',
  );
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, tmp), /migration 0002_bad\.sql failed/);
  const tables = tablesIn(db);
  assert.ok(!tables.has('will_not_persist'), '0002 table must not persist after rollback');
  const v2 = db.prepare('SELECT 1 FROM _migrations WHERE version = 2').get();
  assert.equal(v2, undefined, 'no _migrations row for the failed version');
  const v1 = db.prepare('SELECT 1 FROM _migrations WHERE version = 1').get();
  assert.ok(v1, 'the earlier successful migration stays recorded');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('duplicate migration versions are rejected up front', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-dup-'));
  fs.writeFileSync(path.join(tmp, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  fs.writeFileSync(path.join(tmp, '0001_b.sql'), 'CREATE TABLE b (id INTEGER);');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, tmp), /duplicate migration version 1/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
