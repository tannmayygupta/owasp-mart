// C04 self-test: two quick refunds that each pass the per-request limit but
// together exceed the amount paid are both accepted on the vulnerable build (and
// the goodwill flag line + shop.refund_invariant_broken appear); on the fixed
// build the second is refused and no goodwill row is written. Also: the item
// refund path stays correct (refuses an overshoot), and bad amounts are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const ORDER_ID = 90001;
const MARKER = 'C04-GOODWILL-FLAG-MARKER';

// A seeded delivered order for the player (customer 11), paid 2500, one item.
function seedDeliveredOrder(db) {
  db.prepare("INSERT INTO orders (id, customer_id, status, total_cents, order_no, ship_line1, ship_city, ship_country) VALUES (?,11,'paid',2500,'VM-190001','1 St','Town','Land')").run(ORDER_ID);
  db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,1,1,2500,1,'delivered',250)").run(ORDER_ID);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c04', ?)").run(MARKER);
}

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  seedDeliveredOrder(db);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C04: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

test('C04 exploit PASSES on the vulnerable build (over-refund + goodwill flag + event)', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    assert.equal((await runExploit({ baseUrl, name: 'c04', test: exploit })).passed, true);
    assert.ok(events.some((e) => e.type === 'shop.refund_invariant_broken'), 'expected the invariant-broken event');
    assert.ok(events.filter((e) => e.type === 'shop.refund_decision' && e.data.path === 'quick' && e.data.decision === 'auto_approved').length >= 2, 'expected two quick auto-approvals');
  } finally { server.close(); }
});

test('C04 exploit FAILS on the fixed build (second quick refund refused, no goodwill)', async () => {
  const { db, server, baseUrl } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c04', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build refuses the cumulative overshoot');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM goodwill_adjustment').get().c, 0, 'no goodwill row on the fixed build');
  } finally { server.close(); }
});

test('C04 fixed build: bad amounts are refused and a lone over-limit refund is refused', async () => {
  const { db, server, baseUrl } = await bootShop('fixed');
  try {
    const { quickRefund } = await import('../../../apps/shop/src/challenges/c04-quick-refund.mjs');
    const user = { id: 11, role: 'customer', status: 'active' };
    assert.throws(() => quickRefund(db, user, ORDER_ID, { amount: -5 }, { challenges: { C04: 'fixed' } }), /positive integer/);
    assert.throws(() => quickRefund(db, user, ORDER_ID, { amount: 999999 }, { challenges: { C04: 'fixed' } }), /instant-refund limit/);
  } finally { server.close(); }
  void baseUrl;
});
