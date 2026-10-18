// C08 self-test: the unsigned sandbox webhook turns the order paid and yields the
// flag on the vulnerable build (with order.paid verified=false); on the fixed
// build it is rejected (400). Also: a correctly signed event is accepted on both
// builds but never yields the flag; an unsigned event WITHOUT the sandbox header
// is rejected on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { signPayload } from '../../../apps/shop/src/challenges/c08-payment-webhook.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C08-WEBHOOK-FLAG-MARKER';

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c08', ?)").run(MARKER);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C08: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

// Seed a pending order directly (for the signed/no-header cases).
function pendingOrder(db, total = 1999) {
  const info = db.prepare("INSERT INTO orders (customer_id, status, total_cents, order_no, ship_line1, ship_city, ship_country) VALUES (11,'payment_pending',?,?, '1 St','Town','Land')").run(total, `VM-19${Math.floor(Math.random() * 9000 + 1000)}`);
  return db.prepare('SELECT order_no FROM orders WHERE id = ?').get(Number(info.lastInsertRowid)).order_no;
}
async function postWebhook(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/webhooks/payments`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('C08 exploit PASSES on the vulnerable build (unsigned sandbox webhook -> paid + flag)', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c08', test: exploit });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'order.paid' && e.data.verified === false), 'expected order.paid verified=false');
  } finally { server.close(); }
});

test('C08 exploit FAILS on the fixed build (signature always required)', async () => {
  const { server, baseUrl } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c08', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build rejects the unsigned webhook (clean fail)');
  } finally { server.close(); }
});

test('a correctly signed event is accepted but yields no flag; no-header unsigned is rejected (both builds)', async () => {
  for (const mode of ['vulnerable', 'fixed']) {
    const { db, server, baseUrl } = await bootShop(mode);
    try {
      // signed -> accepted, verified, no flag
      const no1 = pendingOrder(db, 1999);
      const b1 = JSON.stringify({ order_no: no1, amount_cents: 1999, event_id: 'e1' });
      const signed = await postWebhook(baseUrl, b1, { 'x-gateway-signature': signPayload(b1) });
      assert.equal(signed.status, 200, `${mode}: signed event should be accepted`);
      assert.equal(signed.body.verified, true);
      assert.doesNotMatch(String(signed.body.payment_ref ?? ''), /C08-WEBHOOK-FLAG-MARKER/, `${mode}: signed event must not yield the flag`);
      // unsigned, NO sandbox header -> rejected on both builds
      const no2 = pendingOrder(db, 1999);
      const b2 = JSON.stringify({ order_no: no2, amount_cents: 1999, event_id: 'e2' });
      const unsigned = await postWebhook(baseUrl, b2);
      assert.equal(unsigned.status, 400, `${mode}: unsigned without the sandbox header must be rejected`);
    } finally { server.close(); }
  }
});
