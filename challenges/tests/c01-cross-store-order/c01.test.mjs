// C01 self-test: the exploit PASSES against the vulnerable build of the real
// shop and FAILS against the fixed build, and the foreign-order detection event
// fires only on the vulnerable build. Also asserts the support-console order view
// never exposes buyer_note (so a C09 solve cannot read the C01 flag).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { viewOrder } from '../../../apps/shop/src/domain/staff-service.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C01-FOREIGN-ORDER-MARKER';

// A Northwind (store 2) order numbered VM-100777 whose buyer_note holds the
// marker, plus one Northwind order item — the competitor order C01 reads.
function seedForeignOrder(db) {
  const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, order_no, buyer_note, ship_line1, ship_city, ship_country) VALUES (11,'paid',1499,'VM-100777',?, '9 Rival Rd','Teastown','Landia')").run(MARKER);
  const orderId = Number(o.lastInsertRowid);
  db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,3,2,1499,1,'paid',180)").run(orderId);
  return orderId;
}

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  seedForeignOrder(db);
  const events = [];
  const emit = (type, data) => events.push({ type, data });
  const app = createApp({ db, emit, challenges: { C01: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl, events };
}

test('C01 exploit PASSES on the vulnerable build and the cross-store event fires', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c01', test: exploit });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'shop.cross_store_order_read'), 'expected the C01 detection event');
  } finally {
    server.close();
  }
});

test('C01 exploit FAILS on the fixed build (foreign order is a 404, no event)', async () => {
  const { server, baseUrl, events } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c01', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'a fixed build is a clean fail, not an error');
    assert.equal(events.some((e) => e.type === 'shop.cross_store_order_read'), false, 'no detection event on the fixed build');
  } finally {
    server.close();
  }
});

test('the support-console order view never exposes buyer_note', async () => {
  const { db, server } = await bootShop('fixed');
  try {
    const order = db.prepare("SELECT id FROM orders WHERE order_no = 'VM-100777'").get();
    const support = { id: 14, role: 'support_agent', status: 'active' };
    const view = viewOrder(db, support, order.id);
    assert.equal('buyer_note' in view, false, 'support order view must not carry buyer_note');
  } finally {
    server.close();
  }
});
