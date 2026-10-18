// C11 self-test: a malformed tax-id shape crashes the KYC provider; on the
// vulnerable build the catch fails open and auto-approves the store (flag on
// Payouts), on the fixed build it fails closed (pending, no flag). Also: a valid
// tax id stays pending, and an admin/seed-approved store never shows the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { registerStoreWithKyc, sellerPayoutsView } from '../../../apps/shop/src/challenges/c11-kyc-failopen.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C11-PAYOUTS-FLAG-MARKER';

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c11', ?)").run(MARKER);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C11: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}
const userRow = (db, id) => db.prepare('SELECT id, email, role, store_id, status FROM users WHERE id = ?').get(id);

test('C11 exploit PASSES on the vulnerable build (KYC fail-open auto-approves -> flag)', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c11', test: exploit });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'store.approved' && e.data.approved_by === 'system:kyc-fallback'), 'expected the fallback approval event');
  } finally { server.close(); }
});

test('C11 exploit FAILS on the fixed build (provider error fails closed -> pending, no flag)', async () => {
  const { db, server, baseUrl } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c11', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build fails closed (clean fail)');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM stores WHERE approved_by = 'system:kyc-fallback'").get().c, 0, 'no fallback approval on the fixed build');
  } finally { server.close(); }
});

test('a valid tax id stays pending; an admin/seed-approved store shows no flag', async () => {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c11', ?)").run(MARKER);
  // valid id -> pending (customer 16 has no store)
  const out = registerStoreWithKyc(db, userRow(db, 16), { name: 'Good Store', tax_id: 'TAX-12345' }, { challenges: { C11: 'vulnerable' } });
  assert.equal(out.outcome, 'pending');
  // an admin-approved store (approved_by != fallback) shows no flag
  db.prepare("UPDATE stores SET status='approved', approved_by='system:admin' WHERE id = ?").run(out.store_id);
  const owner = userRow(db, 16);
  assert.equal(sellerPayoutsView(db, owner).flag, null, 'an admin-approved store must not show the flag');
});
